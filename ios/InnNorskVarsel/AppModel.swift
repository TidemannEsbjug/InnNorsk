import Foundation
import UIKit
import UserNotifications

/// All tilstand for appen. Én delt instans, så AppDelegate (push) og visningene ser det samme.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published var serverAddress = ""
    @Published var username = ""
    @Published private(set) var isLoggedIn = false
    @Published private(set) var isLoggingIn = false
    @Published private(set) var loginError: String? = nil

    @Published private(set) var overview: Overview? = nil
    @Published private(set) var sendings: [Sending] = []
    @Published private(set) var lastUpdated: Date? = nil
    @Published private(set) var errorMessage: String? = nil
    @Published private(set) var notice: String? = nil
    @Published private(set) var isSendingTest = false

    @Published private(set) var notificationsAllowed: Bool? = nil
    @Published private(set) var deviceToken: String? = nil
    @Published private(set) var registeredToken: String? = nil
    @Published private(set) var pushProblem: String? = nil

    private var isRefreshing = false
    private var refreshQueued = false
    private var pollTask: Task<Void, Never>?

    private enum Keys {
        static let server = "serverAddress"
        static let username = "username"
    }

    private init() {
        let defaults = UserDefaults.standard
        serverAddress = defaults.string(forKey: Keys.server) ?? ""
        username = defaults.string(forKey: Keys.username) ?? ""
        // Øktkapselen overlever omstart; da går vi rett til oversikten og lar serveren si fra hvis den er utløpt.
        isLoggedIn = API(address: serverAddress)?.hasSession ?? false
    }

    private var api: API? {
        API(address: serverAddress)
    }

    /// Oppdater oftere mens noe venter eller oversettes, så fremdriften føles levende.
    private var hasActiveWork: Bool {
        sendings.contains { sending in
            (sending.files ?? []).contains { $0.status == "sent" || $0.status == "working" }
        }
    }

    // MARK: - Livssyklus

    func becameActive() {
        Task { await self.refreshNotificationStatus() }
        guard isLoggedIn else { return }
        startPolling()
        Task {
            await self.refresh()
            await self.registerDevice()
        }
    }

    func wentToBackground() {
        pollTask?.cancel()
        pollTask = nil
    }

    func pushArrived() {
        Task { await self.refresh() }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                let seconds: UInt64 = self.hasActiveWork ? 10 : 60
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                if Task.isCancelled {
                    return
                }
                await self.refresh()
            }
        }
    }

    // MARK: - Innlogging

    /// Returnerer true når innloggingen lyktes (da kan passordfeltet tømmes).
    func login(password: String) async -> Bool {
        guard !isLoggingIn else { return false }
        loginError = nil
        guard let api = api else {
            loginError = APIError.message(for: APIError.invalidAddress)
            return false
        }
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !password.isEmpty else {
            loginError = "Fyll inn brukernavn og passord."
            return false
        }
        isLoggingIn = true
        defer { isLoggingIn = false }
        do {
            let user = try await api.login(username: name, password: password)
            guard user?.role == "admin" else {
                try? await api.logout()
                api.clearCookies()
                loginError = "Denne appen er for oversetteren. Logg inn med admin-brukeren."
                return false
            }
            serverAddress = api.address
            username = name
            UserDefaults.standard.set(api.address, forKey: Keys.server)
            UserDefaults.standard.set(name, forKey: Keys.username)
            isLoggedIn = true
            becameActive()
            return true
        } catch {
            loginError = APIError.message(for: error)
            return false
        }
    }

    func logout() async {
        if let api = api {
            if let token = registeredToken ?? deviceToken {
                try? await api.removeDevice(token: token)
            }
            try? await api.logout()
        }
        endSession(message: nil)
    }

    private func endSession(message: String?) {
        pollTask?.cancel()
        pollTask = nil
        api?.clearCookies()
        isLoggedIn = false
        overview = nil
        sendings = []
        lastUpdated = nil
        errorMessage = nil
        notice = nil
        registeredToken = nil
        loginError = message
    }

    // MARK: - Data

    func refresh() async {
        guard isLoggedIn else { return }
        if isRefreshing {
            refreshQueued = true
            return
        }
        isRefreshing = true
        defer { isRefreshing = false }
        repeat {
            refreshQueued = false
            await load()
        } while refreshQueued && isLoggedIn
    }

    private func load() async {
        guard let api = api else { return }
        do {
            let newOverview = try await api.overview()
            let newSendings = try await api.sendings()
            overview = newOverview
            sendings = newSendings
            lastUpdated = Date()
            errorMessage = nil
        } catch {
            handle(error)
        }
    }

    func sendTestPush() async {
        guard !isSendingTest, let api = api else { return }
        isSendingTest = true
        defer { isSendingTest = false }
        notice = nil
        await registerDevice()
        do {
            let result = try await api.testPush()
            if result.sent == 0 && result.failed == 0 {
                errorMessage = "Ingen telefoner er registrert ennå. Tillat varsler for InnNorsk og prøv igjen om litt."
            } else if result.failed == 0 {
                errorMessage = nil
                let unit = result.sent == 1 ? "enhet" : "enheter"
                show(notice: "Testvarsel sendt til \(result.sent) \(unit). Det skal komme om noen sekunder.")
            } else {
                let details = result.errors.joined(separator: "\n")
                errorMessage = "Testvarselet kom ikke fram til \(result.failed) av \(result.sent + result.failed) enheter.\n\(details)"
            }
        } catch {
            handle(error)
        }
    }

    private func show(notice text: String) {
        notice = text
        Task {
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            if self.notice == text {
                self.notice = nil
            }
        }
    }

    private func handle(_ error: Error) {
        if APIError.isCancellation(error) {
            return
        }
        if let apiError = error as? APIError, apiError.isUnauthorized {
            endSession(message: "Økten er utløpt. Logg inn igjen.")
            return
        }
        errorMessage = APIError.message(for: error)
    }

    // MARK: - Varsler

    var pushReady: Bool {
        notificationsAllowed != false && pushProblem == nil && registeredToken != nil
    }

    var pushStatusText: String {
        if notificationsAllowed == false {
            return "Varsler er slått av for InnNorsk. Slå dem på i Innstillinger."
        }
        if let problem = pushProblem {
            return problem
        }
        if deviceToken == nil {
            return "Venter på varsel-ID fra Apple …"
        }
        if registeredToken == nil {
            return "Telefonen er ikke registrert på serveren ennå."
        }
        let kind = PushEnvironment.current == "sandbox" ? "utviklerbygg (sandbox)" : "TestFlight/App Store (production)"
        return "Varsler er på for denne telefonen – \(kind)."
    }

    func requestNotificationPermission() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        await refreshNotificationStatus()
    }

    private func refreshNotificationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .denied:
            notificationsAllowed = false
        case .notDetermined:
            notificationsAllowed = nil
        default:
            notificationsAllowed = true
        }
    }

    func deviceTokenReceived(_ token: String) {
        deviceToken = token
        pushProblem = nil
        Task { await self.registerDevice() }
    }

    func deviceRegistrationFailed(_ error: Error) {
        pushProblem = "Apple ga ingen varsel-ID (\(error.localizedDescription)). "
            + "Sjekk at Push Notifications er slått på under Signing & Capabilities, og bruk en ekte iPhone."
    }

    /// Sender tokenet til serveren etter innlogging og hver gang Apple gir et nytt.
    private func registerDevice() async {
        guard isLoggedIn, let token = deviceToken, token != registeredToken, let api = api else { return }
        do {
            try await api.registerDevice(token: token, env: PushEnvironment.current, name: UIDevice.current.name)
            registeredToken = token
            pushProblem = nil
        } catch {
            if APIError.isCancellation(error) {
                return
            }
            if let apiError = error as? APIError, apiError.isUnauthorized {
                endSession(message: "Økten er utløpt. Logg inn igjen.")
                return
            }
            pushProblem = "Kunne ikke registrere telefonen for varsler: \(APIError.message(for: error))"
        }
    }
}

enum PushEnvironment {
    /// APNs-miljøet tokenet hører til: «sandbox» for bygg fra Xcode, «production» for TestFlight/App Store.
    static var current: String {
        if let value = provisioningValue() {
            return value == "production" ? "production" : "sandbox"
        }
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// aps-environment fra embedded.mobileprovision. Finnes i bygg fra Xcode og ad hoc, ikke fra App Store/TestFlight.
    private static func provisioningValue() -> String? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<plist".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else {
            return nil
        }
        let plistData = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = try? PropertyListSerialization.propertyList(from: plistData, options: [], format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any] else {
            return nil
        }
        return entitlements["aps-environment"] as? String
    }
}
