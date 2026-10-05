import Foundation

struct WalkmanResponse: Decodable {
    let cards: [WalkmanCard]
}

struct WalkmanCard: Decodable, Identifiable {
    let id: String
    let front: String
    let back: String
    let example: String?

    enum CodingKeys: String, CodingKey {
        case id, front, back, example
    }
}

struct TimedLine: Decodable {
    let index: Int
    let offsetMs: Double?
    let bookmarkOffsetMs: Double?
    let firstWord: String?
}

struct TimedTTSResult {
    let audioData: Data
    let timings: [TimedLine]
}
