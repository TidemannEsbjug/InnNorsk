import Foundation

// Norske tekster for tid, varighet og størrelse – samme ordlyd som nettsiden (web/js/api.js).
enum Fmt {
    private static let norsk = Locale(identifier: "nb_NO")

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoPlain = ISO8601DateFormatter()

    // SQLite datetime('now'): «2026-09-24 14:32:10» i UTC.
    private static let sqlite: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Fmt.norsk
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Fmt.norsk
        formatter.dateFormat = "d. MMM"
        return formatter
    }()

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Fmt.norsk
        formatter.unitsStyle = .full
        return formatter
    }()

    static func date(_ text: String?) -> Date? {
        guard let text = text, !text.isEmpty else { return nil }
        return isoFractional.date(from: text) ?? isoPlain.date(from: text) ?? sqlite.date(from: text)
    }

    /// «14:32»
    static func clock(_ date: Date) -> String {
        clockFormatter.string(from: date)
    }

    /// «i dag kl. 14:32», «i går kl. 09:05», «3. sep. kl. 18:40»
    static func dayAndTime(_ date: Date) -> String {
        let calendar = Calendar.current
        let day: String
        if calendar.isDateInToday(date) {
            day = "i dag"
        } else if calendar.isDateInYesterday(date) {
            day = "i går"
        } else {
            day = dayFormatter.string(from: date)
        }
        return "\(day) kl. \(clock(date))"
    }

    /// «akkurat nå», «for 3 minutter siden»
    static func relative(_ date: Date) -> String {
        if abs(date.timeIntervalSinceNow) < 45 {
            return "akkurat nå"
        }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    /// «under 1 min», «ca. 3 min», «ca. 1 t 5 min»
    static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 60 else {
            return "under 1 min"
        }
        let minutes = Int((min(seconds, 360_000) / 60).rounded())
        if minutes < 60 {
            return "ca. \(minutes) min"
        }
        let rest = minutes % 60
        return rest == 0 ? "ca. \(minutes / 60) t" : "ca. \(minutes / 60) t \(rest) min"
    }

    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }
}
