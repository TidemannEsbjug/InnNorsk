import SwiftUI
import UIKit

/// Varme farger som på nettsiden: lin, terrakotta, aprikos og salvie. Egne nyanser i mørk modus.
enum Theme {
    static let accent = Theme.adaptive(light: (0.70, 0.35, 0.22), dark: (0.93, 0.58, 0.44))
    static let waiting = Theme.adaptive(light: (0.62, 0.38, 0.06), dark: (0.95, 0.70, 0.38))
    static let done = Theme.adaptive(light: (0.27, 0.47, 0.33), dark: (0.56, 0.78, 0.60))
    static let failed = Theme.adaptive(light: (0.72, 0.20, 0.17), dark: (0.96, 0.52, 0.47))
    static let background = Theme.adaptive(light: (0.98, 0.95, 0.90), dark: (0.13, 0.11, 0.10))

    private static func adaptive(light: (Double, Double, Double), dark: (Double, Double, Double)) -> Color {
        Color(uiColor: UIColor(dynamicProvider: { traits in
            let rgb = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1)
        }))
    }
}

enum StatusStyle {
    static func label(_ status: String?) -> String {
        switch status ?? "" {
        case "draft":
            return "Utkast"
        case "sent":
            return "Venter"
        case "working":
            return "Oversettes"
        case "done":
            return "Ferdig"
        case "failed":
            return "Feilet"
        default:
            return "Ukjent"
        }
    }

    static func color(_ status: String?) -> Color {
        switch status ?? "" {
        case "sent":
            return Theme.waiting
        case "working":
            return Theme.accent
        case "done":
            return Theme.done
        case "failed":
            return Theme.failed
        default:
            return Color.secondary
        }
    }
}

struct StatusPill: View {
    let status: String?

    var body: some View {
        Text(StatusStyle.label(status))
            .font(.caption.weight(.semibold))
            .foregroundStyle(StatusStyle.color(status))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(StatusStyle.color(status).opacity(0.15), in: Capsule())
    }
}
