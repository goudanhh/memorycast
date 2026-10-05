import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: WalkmanViewModel

    var body: some View {
        VStack(spacing: 6) {
            if model.isLoading {
                ProgressView()
                    .controlSize(.small)
            }

            if !model.status.isEmpty {
                Text(model.status)
                    .font(.caption2)
                    .multilineTextAlignment(.center)
            }

            if !model.lines.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 8) {
                            ForEach(Array(model.lines.enumerated()), id: \.offset) { index, line in
                                Text(line)
                                    .font(index == model.activeLineIndex ? .headline : .caption)
                                    .foregroundStyle(index == model.activeLineIndex ? .primary : .secondary)
                                    .multilineTextAlignment(.center)
                                    .id(index)
                            }
                        }
                        .padding(.horizontal, 4)
                    }
                    .onChange(of: model.activeLineIndex) { _, newValue in
                        withAnimation(.easeInOut(duration: 0.2)) {
                            proxy.scrollTo(newValue, anchor: .center)
                        }
                    }
                }
            }

            HStack(spacing: 8) {
                Button {
                    model.previous()
                } label: {
                    Image(systemName: "backward.end.fill")
                }

                Menu {
                    Button("0.8×") { model.setRate(0.8) }
                    Button("1.0×") { model.setRate(1.0) }
                    Button("1.2×") { model.setRate(1.2) }
                    Button("1.5×") { model.setRate(1.5) }
                } label: {
                    Text(String(format: "%.1f×", model.rate))
                        .font(.caption2)
                }

                Button {
                    model.next()
                } label: {
                    Image(systemName: "forward.end.fill")
                }
            }
            .buttonStyle(.bordered)
            .font(.caption2)
        }
        .padding(.horizontal, 4)
        .navigationTitle("随身听")
    }
}
