import Foundation
import CommonCrypto

enum APIError: Error {
    case invalidAddress
    case unauthorized(String?)
    case server(status: Int, message: String?)
    case badResponse

    var isUnauthorized: Bool {
        if case .unauthorized = self {
            return true
        }
        return false
    }

    /// Vennlig norsk tekst for alle feil appen kan møte.
    static func message(for error: Error) -> String {
        if let apiError = error as? APIError {
            switch apiError {
            case .invalidAddress:
                return "Serveradressen ser ikke riktig ut. Skriv den som https://oversetter.dittnavn.workers.dev."
            case .unauthorized(let message):
                return message ?? "Du er ikke logget inn."
            case .server(let status, let message):
                if let message = message, !message.isEmpty {
                    return message
                }
                return status >= 500
                    ? "Serveren hadde et problem (\(status)). Prøv igjen om litt."
                    : "Serveren svarte med feil \(status)."
            case .badResponse:
                return "Uventet svar fra serveren. Sjekk at adressen er riktig."
            }
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost:
                return "Ingen internettforbindelse. Prøv igjen når du er på nett."
            case .timedOut:
                return "Serveren svarte ikke i tide. Prøv igjen om litt."
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return "Fant ikke serveren. Sjekk adressen."
            case .appTransportSecurityRequiresSecureConnection, .secureConnectionFailed,
                 .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid:
                return "Kunne ikke lage en sikker forbindelse. Adressen må begynne med https://."
            default:
                return "Nettverksfeil: \(urlError.localizedDescription)"
            }
        }
        if error is DecodingError {
            return "Uventet svar fra serveren. Sjekk at adressen er riktig og at nettsiden er oppdatert."
        }
        return "Noe gikk galt: \(error.localizedDescription)"
    }

    /// Avbrutte forespørsler (f.eks. dra-for-å-oppdatere som slippes) er ikke feil.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError {
            return true
        }
        if let urlError = error as? URLError, urlError.code == .cancelled {
            return true
        }
        return false
    }
}

/// Klient for InnNorsk-Workeren. Samme innlogging som nettsiden: salt → PBKDF2 på telefonen → proof.
/// Øktkapselen (innnorsk_sid) ligger i HTTPCookieStorage.shared og overlever omstart av appen.
struct API {
    /// Normalisert adresse uten skråstrek til slutt, f.eks. «https://oversetter.dittnavn.workers.dev».
    let address: String

    /// Godtar «oversetter.dittnavn.workers.dev», en hel lenke eller en lenke til en underside; nettsiden ligger alltid på roten.
    init?(address raw: String) {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = text.lowercased()
        if !lower.hasPrefix("https://") && !lower.hasPrefix("http://") {
            text = "https://" + text
        }
        guard let components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty else {
            return nil
        }
        let port = components.port.map { ":\($0)" } ?? ""
        address = "\(scheme)://\(host)\(port)"
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    private var baseURL: URL? {
        URL(string: address)
    }

    var hasSession: Bool {
        guard let url = baseURL, let cookies = HTTPCookieStorage.shared.cookies(for: url) else {
            return false
        }
        return cookies.contains { $0.name == "innnorsk_sid" }
    }

    func clearCookies() {
        guard let url = baseURL, let cookies = HTTPCookieStorage.shared.cookies(for: url) else {
            return
        }
        for cookie in cookies {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
    }

    // MARK: - Endepunkter

    /// Logger inn og returnerer brukeren. Passordet forlater aldri telefonen.
    func login(username: String, password: String) async throws -> User? {
        let saltData = try await send("POST", "/api/auth/salt", body: ["username": username])
        let salt = try decode(SaltResponse.self, from: saltData)
        // 310 000 runder PBKDF2 tar et øyeblikk; regn dem ut utenfor hovedtråden.
        let proof = try await Task.detached(priority: .userInitiated) {
            try Crypto.pbkdf2Proof(password: password, salt: salt.salt, iterations: salt.iterations)
        }.value
        let data = try await send("POST", "/api/auth/login", body: ["username": username, "proof": proof])
        return try decode(LoginResponse.self, from: data).user
    }

    func logout() async throws {
        try await send("POST", "/api/auth/logout", body: [:])
    }

    func overview() async throws -> Overview {
        let data = try await send("GET", "/api/admin/overview")
        return try decode(Overview.self, from: data)
    }

    func sendings() async throws -> [Sending] {
        let data = try await send("GET", "/api/admin/sendings?limit=30")
        return try decode(SendingsResponse.self, from: data).sendings
    }

    func registerDevice(token: String, env: String, name: String) async throws {
        try await send("POST", "/api/admin/devices", body: ["token": token, "env": env, "name": name])
    }

    func removeDevice(token: String) async throws {
        try await send("DELETE", "/api/admin/devices/\(token)")
    }

    func testPush() async throws -> TestPushResult {
        let data = try await send("POST", "/api/admin/test-push", body: [:])
        return try decode(TestPushResult.self, from: data)
    }

    // MARK: - HTTP

    @discardableResult
    private func send(_ method: String, _ path: String, body: [String: String]? = nil) async throws -> Data {
        guard let url = URL(string: address + path) else {
            throw APIError.invalidAddress
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("ios", forHTTPHeaderField: "X-InnNorsk-Client")
        if method != "GET" {
            request.setValue("1", forHTTPHeaderField: "X-InnNorsk")
        }
        if let body = body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await API.session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.badResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            if http.statusCode == 401 {
                throw APIError.unauthorized(message)
            }
            throw APIError.server(status: http.statusCode, message: message)
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data)
    }
}

enum Crypto {
    /// base64url(PBKDF2-HMAC-SHA256(passord, salt, runder, 32 byte)) – identisk med pbkdf2Proof i web/js/api.js.
    static func pbkdf2Proof(password: String, salt: String, iterations: Int) throws -> String {
        guard let saltData = Data(base64URLEncoded: salt), !saltData.isEmpty,
              iterations > 0, iterations <= 10_000_000 else {
            throw APIError.badResponse
        }
        let saltBytes = [UInt8](saltData)
        let keyLength = 32
        var derived = [UInt8](repeating: 0, count: keyLength)
        let status = CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2),
            password, password.utf8.count,
            saltBytes, saltBytes.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
            UInt32(iterations),
            &derived, keyLength
        )
        guard Int(status) == kCCSuccess else {
            throw APIError.badResponse
        }
        return Data(derived).base64URLEncodedString()
    }
}

extension Data {
    init?(base64URLEncoded text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        self.init(base64Encoded: base64)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
