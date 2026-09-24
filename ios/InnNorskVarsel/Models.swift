import Foundation

// JSON-formene fra Workeren (se spesifikasjonen). Alt serveren kan utelate er valgfritt,
// og tidspunkter holdes som tekst og tolkes i Fmt.date, så et uventet format aldri stopper listen.

struct ErrorBody: Decodable {
    let error: String?
}

struct SaltResponse: Decodable {
    let salt: String
    let iterations: Int
}

struct User: Decodable {
    let username: String?
    let displayName: String?
    let role: String?
}

struct LoginResponse: Decodable {
    let user: User?
}

struct Overview: Decodable {
    let agent: AgentInfo?
    let counts: OverviewCounts?
}

struct AgentInfo: Decodable {
    let online: Bool
    let lastSeenAt: String?
    let host: String?
    let version: String?
    let state: String?
    let stateMessage: String?
    let grokOk: Bool?

    private enum CodingKeys: String, CodingKey {
        case online, lastSeenAt, host, version, state, stateMessage, grokOk
    }

    // SQLite har ikke boolsk type; godta både true/false og 1/0.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        online = c.flexibleBool(forKey: .online) ?? false
        lastSeenAt = try? c.decodeIfPresent(String.self, forKey: .lastSeenAt)
        host = try? c.decodeIfPresent(String.self, forKey: .host)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        stateMessage = try? c.decodeIfPresent(String.self, forKey: .stateMessage)
        grokOk = c.flexibleBool(forKey: .grokOk)
    }
}

struct OverviewCounts: Decodable {
    let waiting: Int?
    let working: Int?
    let doneToday: Int?
    let failed: Int?
}

struct SendingsResponse: Decodable {
    let sendings: [Sending]
}

struct Sending: Decodable, Identifiable {
    let id: String
    let username: String?
    let displayName: String?
    let status: String?
    let targetLanguage: String?
    let note: String?
    let reply: String?
    let createdAt: String?
    let sentAt: String?
    let files: [FileItem]?
}

struct FileItem: Decodable, Identifiable {
    let id: String
    let path: String?
    let name: String?
    let bytes: Int?
    let status: String?
    let statusText: String?
    let progress: FileProgress?
    let outputName: String?
    let finishedAt: String?
    // Bare for admin:
    let message: String?
    let error: String?
    let attempts: Int?
    let costUsd: Double?
}

struct FileProgress: Decodable {
    let percent: Double?
    let etaSeconds: Double?
}

struct TestPushResult: Decodable {
    let sent: Int
    let failed: Int
    let errors: [String]

    private enum CodingKeys: String, CodingKey {
        case sent, failed, errors
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sent = (try? c.decodeIfPresent(Int.self, forKey: .sent)) ?? 0
        failed = (try? c.decodeIfPresent(Int.self, forKey: .failed)) ?? 0
        errors = (try? c.decodeIfPresent([String].self, forKey: .errors)) ?? []
    }
}

extension KeyedDecodingContainer {
    func flexibleBool(forKey key: Key) -> Bool? {
        if let value = try? decodeIfPresent(Bool.self, forKey: key) {
            return value
        }
        if let value = try? decodeIfPresent(Int.self, forKey: key) {
            return value != 0
        }
        return nil
    }
}
