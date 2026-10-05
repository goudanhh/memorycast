import SwiftUI

@main
struct MemoryCastWatchApp: App {
    @StateObject private var model = WalkmanViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .task {
                    await model.start()
                }
        }
    }
}
