import SwiftUI
import UIKit

/// Oversikten etter innlogging: Mac-en, sendingene, varsler og utlogging.
struct DashboardView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var confirmLogout = false

    var body: some View {
        NavigationStack {
            List {
                if let message = model.errorMessage {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.failed)
                    }
                }
                if let notice = model.notice {
                    Section {
                        Label(notice, systemImage: "checkmark.circle.fill")
                            .foregroundStyle(Theme.done)
                    }
                }

                Section {
                    AgentCard(overview: model.overview, hasLoaded: model.lastUpdated != nil)
                } header: {
                    Text("Mac mini")
                } footer: {
                    Text(Self.updatedText(model.lastUpdated))
                }

                if model.sendings.isEmpty {
                    Section {
                        Text(Self.emptyText(hasLoaded: model.lastUpdated != nil))
                            .foregroundStyle(.secondary)
                    } header: {
                        Text("Sendinger")
                    }
                } else {
                    ForEach(model.sendings) { sending in
                        SendingSection(sending: sending)
                    }
                }

                Section {
                    Label {
                        Text(model.pushStatusText)
                    } icon: {
                        Image(systemName: model.pushReady ? "bell.badge.fill" : "bell.slash")
                            .foregroundStyle(model.pushReady ? Theme.done : Theme.waiting)
                    }
                    if model.notificationsAllowed == false, let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        Button("Åpne innstillinger") {
                            openURL(url)
                        }
                    }
                    Button {
                        Task { @MainActor in
                            await model.sendTestPush()
                        }
                    } label: {
                        HStack {
                            Label("Send testvarsel", systemImage: "paperplane")
                            if model.isSendingTest {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(model.isSendingTest)
                } header: {
                    Text("Varsler")
                }

                Section {
                    Button(role: .destructive) {
                        confirmLogout = true
                    } label: {
                        Label("Logg ut", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                } footer: {
                    Text(verbatim: "Innlogget som \(model.username) på \(model.serverAddress)")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("InnNorsk")
            .refreshable {
                await model.refresh()
            }
            .confirmationDialog("Logge ut?", isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("Logg ut", role: .destructive) {
                    Task { @MainActor in
                        await model.logout()
                    }
                }
            } message: {
                Text("Du får ikke varsler på denne telefonen før du logger inn igjen.")
            }
        }
    }

    private static func updatedText(_ date: Date?) -> String {
        guard let date = date else { return "Henter status …" }
        return "Oppdatert kl. \(Fmt.clock(date)). Dra ned for å oppdatere."
    }

    private static func emptyText(hasLoaded: Bool) -> String {
        hasLoaded
            ? "Ingen sendinger ennå. Du får et varsel når det kommer nye filer."
            : "Henter sendinger …"
    }
}

struct AgentCard: View {
    let overview: Overview?
    let hasLoaded: Bool

    var body: some View {
        if let agent = overview?.agent {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Circle()
                        .fill(agent.online ? Theme.done : Theme.failed)
                        .frame(width: 12, height: 12)
                    Text(agent.title)
                        .font(.headline)
                }
                Text(agent.lastSeenText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let message = agent.stateMessage, !message.isEmpty {
                    Text(message)
                        .font(.subheadline)
                }
                if let grokOk = agent.grokOk {
                    Label(agent.grokText, systemImage: grokOk ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(grokOk ? Theme.done : Theme.waiting)
                }
                if let counts = overview?.counts {
                    Text(counts.summary)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let host = agent.hostText {
                    Text(host)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.vertical, 4)
        } else if hasLoaded {
            Text("Mac-en har ikke meldt seg ennå. Kjør «node mac/innnorsk-mottak.js doctor» på Mac-en.")
                .foregroundStyle(.secondary)
        } else {
            HStack(spacing: 10) {
                ProgressView()
                Text("Henter status …")
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct SendingSection: View {
    let sending: Sending

    var body: some View {
        Section {
            if let note = sending.note, !note.isEmpty {
                Label {
                    Text(note)
                        .italic()
                } icon: {
                    Image(systemName: "text.bubble")
                        .foregroundStyle(Theme.accent)
                }
                .font(.subheadline)
            }
            ForEach(sending.files ?? []) { file in
                FileRow(file: file)
            }
            if let reply = sending.reply, !reply.isEmpty {
                Label {
                    Text(verbatim: "Ditt svar: \(reply)")
                } icon: {
                    Image(systemName: "arrowshape.turn.up.left")
                        .foregroundStyle(Theme.accent)
                }
                .font(.subheadline)
            }
        } header: {
            HStack {
                Text(sending.senderName)
                Spacer()
                Text(sending.timeText)
            }
            .textCase(nil)
        } footer: {
            Text(sending.summary)
        }
    }
}

struct FileRow: View {
    let file: FileItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(file.displayName)
                    .lineLimit(2)
                Spacer(minLength: 8)
                StatusPill(status: file.status)
            }
            if file.status == "working" {
                ProgressView(value: file.fraction)
                    .tint(Theme.accent)
            }
            Text(file.detailText)
                .font(.footnote)
                .foregroundStyle(file.status == "failed" ? Theme.failed : Color.secondary)
            if let meta = file.metaText {
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Tekster

extension AgentInfo {
    var title: String {
        online ? "Mac mini er på" : "Mac mini svarer ikke"
    }

    var lastSeenText: String {
        guard let date = Fmt.date(lastSeenAt) else {
            return "Har ikke vært i kontakt ennå."
        }
        return "Sist sett \(Fmt.relative(date)) (\(Fmt.dayAndTime(date)))"
    }

    var grokText: String {
        grokOk == true ? "Grok CLI er klar" : "Grok CLI er ikke klar"
    }

    var hostText: String? {
        let parts = [host, version.map { "versjon \($0)" }].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

extension OverviewCounts {
    var summary: String {
        "\(waiting ?? 0) venter · \(working ?? 0) oversettes · \(doneToday ?? 0) ferdig i dag · \(failed ?? 0) feilet"
    }
}

extension Sending {
    var senderName: String {
        if let name = displayName, !name.isEmpty {
            return name
        }
        return username ?? "Ukjent avsender"
    }

    var timeText: String {
        guard let date = Fmt.date(sentAt) ?? Fmt.date(createdAt) else {
            return ""
        }
        return Fmt.dayAndTime(date)
    }

    var summary: String {
        let list = files ?? []
        let done = list.filter { $0.status == "done" }.count
        var parts = [targetLanguage == "nynorsk" ? "Til nynorsk" : "Til bokmål", "\(done) av \(list.count) ferdig"]
        if status == "draft" {
            parts.append("ikke sendt ennå")
        }
        return parts.joined(separator: " · ")
    }
}

extension FileItem {
    var displayName: String {
        if let path = path, !path.isEmpty {
            return path
        }
        return name ?? "Uten navn"
    }

    var fraction: Double {
        guard let percent = progress?.percent, percent.isFinite else {
            return 0
        }
        return min(max(percent / 100, 0), 1)
    }

    var detailText: String {
        switch status ?? "" {
        case "working":
            guard let percent = progress?.percent, percent.isFinite else {
                return "Oversettes nå – starter opp …"
            }
            var text = "\(Int(min(max(percent, 0), 100).rounded())) %"
            if let eta = progress?.etaSeconds, eta.isFinite {
                let finish = Date().addingTimeInterval(min(max(eta, 0), 360_000))
                text += " · \(Fmt.duration(eta)) igjen – ferdig rundt kl. \(Fmt.clock(finish))"
            }
            return text
        case "failed":
            return error ?? message ?? statusText ?? "Feilet"
        case "done":
            let time = Fmt.date(finishedAt).map { " kl. \(Fmt.clock($0))" } ?? ""
            let output = outputName.map { " – \($0)" } ?? ""
            return "Ferdig" + time + output
        default:
            return statusText ?? StatusStyle.label(status)
        }
    }

    var metaText: String? {
        var parts: [String] = []
        if let bytes = bytes {
            parts.append(Fmt.bytes(bytes))
        }
        if let attempts = attempts, attempts > 1 {
            parts.append("\(attempts). forsøk")
        }
        if let cost = costUsd, cost > 0 {
            parts.append(String(format: "$%.3f", cost))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
