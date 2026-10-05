import Foundation
import AVFoundation

@MainActor
final class WalkmanViewModel: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var cards: [WalkmanCard] = []
    @Published var cardIndex = 0
    @Published var lines: [String] = []
    @Published var activeLineIndex = 0
    @Published var status = "正在连接…"
    @Published var isLoading = false
    @Published var rate: Double = 1.0

    private let api = APIClient()
    private var player: AVAudioPlayer?
    private var timer: Timer?
    private var timings: [TimedLine] = []
    private var generation = 0

    var currentCard: WalkmanCard? {
        guard cards.indices.contains(cardIndex) else { return nil }
        return cards[cardIndex]
    }

    func start() async {
        guard cards.isEmpty else { return }
        do {
            status = "正在加载随身听…"
            cards = try await api.fetchWalkman()
            guard !cards.isEmpty else {
                status = "暂无可播放内容"
                return
            }
            cardIndex = 0
            await playCurrent()
        } catch {
            status = "加载失败：\(error.localizedDescription)"
        }
    }

    func playCurrent() async {
        guard let card = currentCard else { return }
        generation += 1
        let myGeneration = generation

        stopPlayer()
        lines = subtitleLines(for: card)
        activeLineIndex = 0
        guard !lines.isEmpty else {
            await advance()
            return
        }

        isLoading = true
        status = "正在准备语音…"

        do {
            let result = try await api.fetchTimedTTS(lines: lines, rate: rate)
            guard myGeneration == generation else { return }

            timings = result.timings
            try configureAudioSession()
            try play(data: result.audioData)

            isLoading = false
            status = ""
            beginSubtitleTimer()
        } catch {
            isLoading = false
            status = "播放失败：\(error.localizedDescription)"
        }
    }

    func next() {
        Task { await advance() }
    }

    func previous() {
        guard !cards.isEmpty else { return }
        generation += 1
        cardIndex = (cardIndex - 1 + cards.count) % cards.count
        Task { await playCurrent() }
    }

    func setRate(_ newRate: Double) {
        rate = newRate
        Task { await playCurrent() }
    }

    private func advance() async {
        guard !cards.isEmpty else { return }
        generation += 1
        cardIndex = (cardIndex + 1) % cards.count
        await playCurrent()
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
    }

    private func play(data: Data) throws {
        let p = try AVAudioPlayer(data: data)
        p.delegate = self
        p.enableRate = true
        p.rate = 1.0
        p.prepareToPlay()
        guard p.play() else {
            throw APIError.invalidData
        }
        player = p
    }

    private func beginSubtitleTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.syncSubtitle()
            }
        }
    }

    private func syncSubtitle() {
        guard let player else { return }
        let currentMs = player.currentTime * 1000

        var best = 0
        for timing in timings {
            let offset = timing.offsetMs ?? timing.bookmarkOffsetMs ?? 0
            if currentMs >= offset {
                best = max(best, timing.index)
            }
        }
        activeLineIndex = min(best, max(0, lines.count - 1))
    }

    private func stopPlayer() {
        timer?.invalidate()
        timer = nil
        player?.stop()
        player = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            await self.advance()
        }
    }

    private func subtitleLines(for card: WalkmanCard) -> [String] {
        let combined = [card.front, card.back, card.example ?? ""]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")

        let normalized = combined
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalized.isEmpty else { return [] }

        let pattern = #"[^。！？!?]+[。！？!?]?"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return [normalized]
        }

        let range = NSRange(normalized.startIndex..<normalized.endIndex, in: normalized)
        let parts = regex.matches(in: normalized, range: range).compactMap { match -> String? in
            guard let r = Range(match.range, in: normalized) else { return nil }
            let text = String(normalized[r]).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }

        return parts.isEmpty ? [normalized] : parts
    }
}
