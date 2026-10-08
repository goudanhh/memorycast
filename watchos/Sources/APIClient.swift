import Foundation

enum APIError: Error, LocalizedError {
    case badResponse(Int)
    case invalidData
    case invalidTimingHeader

    var errorDescription: String? {
        switch self {
        case .badResponse(let code): return "服务器返回 HTTP \(code)"
        case .invalidData: return "服务器返回的数据无法解析"
        case .invalidTimingHeader: return "字幕时间轴无法解析"
        }
    }
}

struct APIClient {
    func fetchWalkman() async throws -> [WalkmanCard] {
        let url = AppConfig.apiBaseURL.appendingPathComponent("walkman")
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidData
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse(http.statusCode)
        }
        return try JSONDecoder().decode(WalkmanResponse.self, from: data).cards
    }

    func fetchTimedTTS(lines: [String], rate: Double = 1.0) async throws -> TimedTTSResult {
        let url = AppConfig.apiBaseURL.appendingPathComponent("tts/timed")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload: [String: Any] = [
            // 服务器要求每行是 { parts: [{ text, language, style, rate }] }
            // 以前发的是 { text, language, rate }（少了 parts 包裹层），
            // 服务器把每行的 parts 解析成空数组 → 400 "Timed TTS lines are required" → 无声
            "lines": lines.map { line in
                [
                    "parts": [
                        [
                            "text": line,
                            "language": language(for: line),
                            "style": "smart",
                            "rate": rate
                        ]
                    ]
                ]
            },
            "format": "mp3"
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidData
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse(http.statusCode)
        }

        let timings = decodeTimings(http.value(forHTTPHeaderField: "X-MemoryCast-Timings"))
        return TimedTTSResult(audioData: data, timings: timings)
    }

    private func language(for text: String) -> String {
        text.range(of: "[\\u{3400}-\\u{9FFF}]", options: .regularExpression) != nil
            ? "zh-CN"
            : "en-US"
    }

    private func decodeTimings(_ raw: String?) -> [TimedLine] {
        guard var encoded = raw, !encoded.isEmpty else { return [] }
        encoded = encoded.replacingOccurrences(of: "-", with: "+")
                         .replacingOccurrences(of: "_", with: "/")
        let remainder = encoded.count % 4
        if remainder != 0 {
            encoded += String(repeating: "=", count: 4 - remainder)
        }
        guard let data = Data(base64Encoded: encoded) else { return [] }
        return (try? JSONDecoder().decode([TimedLine].self, from: data)) ?? []
    }
}
