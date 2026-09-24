import SwiftUI
import UIKit
import UserNotifications

@main
struct InnNorskVarselApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(AppModel.shared)
                .tint(Theme.accent)
        }
    }
}

/// Registrerer for push, sender enhets-ID-en til serveren og viser varsler også når appen er åpen.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Task {
            await AppModel.shared.requestNotificationPermission()
        }
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        AppModel.shared.deviceTokenReceived(hex)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        AppModel.shared.deviceRegistrationFailed(error)
    }

    // Varsel mens appen er åpen: vis banneret og hent ferske data.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
        Task { @MainActor in
            AppModel.shared.pushArrived()
        }
    }

    // Trykk på et varsel: appen åpnes og oppdateres.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor in
            AppModel.shared.pushArrived()
        }
        completionHandler()
    }
}
