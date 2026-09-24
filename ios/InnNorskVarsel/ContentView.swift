import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.isLoggedIn {
                DashboardView()
            } else {
                LoginView()
            }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .active:
                model.becameActive()
            case .background:
                model.wentToBackground()
            default:
                break
            }
        }
    }
}

/// Innstillinger og pålogging: serveradresse, brukernavn og passord.
struct LoginView: View {
    @EnvironmentObject private var model: AppModel
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case server, username, password
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Image(systemName: "paperplane.circle.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(Theme.accent)
                        Text("Velkommen")
                            .font(.system(.largeTitle, design: .serif, weight: .semibold))
                        Text("Logg inn for å få beskjed på iPhonen når det kommer nye dokumenter, og følg med mens Mac-en oversetter dem.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }
                .listRowBackground(Color.clear)

                Section {
                    TextField("https://innnorsk.dittnavn.workers.dev", text: $model.serverAddress)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .server)
                        .submitLabel(.next)
                        .onSubmit { focus = .username }
                } header: {
                    Text("Serveradresse")
                } footer: {
                    Text("Den samme adressen som nettsiden har i nettleseren.")
                }

                Section {
                    TextField("Brukernavn", text: $model.username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .username)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }
                    SecureField("Passord", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                } header: {
                    Text("Pålogging")
                }

                if let message = model.loginError {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.failed)
                    }
                }

                Section {
                    Button {
                        submit()
                    } label: {
                        HStack(spacing: 10) {
                            Spacer()
                            if model.isLoggingIn {
                                ProgressView()
                                Text("Logger inn …")
                            } else {
                                Text("Logg inn")
                                    .bold()
                            }
                            Spacer()
                        }
                    }
                    .disabled(model.isLoggingIn)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("InnNorsk")
        }
    }

    @MainActor
    private func submit() {
        focus = nil
        Task { @MainActor in
            if await model.login(password: password) {
                password = ""
            }
        }
    }
}
