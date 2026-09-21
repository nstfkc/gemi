package dev.gemijs.chat

import java.io.ByteArrayOutputStream
import kotlinx.serialization.json.JsonElement

/** One SSE frame: the event and its position in the run. */
public data class StreamFrame(
  /** The frame's `id:`. What `/attach` resumes from. */
  val seq: Int,
  /** The `AgentStreamEvent`, as sent. */
  val event: JsonElement,
)

/**
 * Bytes to frames. A port of `ai/client/sse.ts`, held to the same recorded
 * cases (`ai/client/__fixtures__/sse.json`).
 *
 * Works on bytes where the TypeScript works on decoded text, which changes
 * nothing it can observe: every SSE delimiter is ASCII, so a frame is only
 * turned into a string once it is complete — and a chunk ending halfway
 * through a UTF-8 character needs no streaming decoder.
 */
public class SSEFrameDecoder {
  private var buffer = ByteArrayOutputStream()
  /** A CR at the very end of a chunk may be half a CRLF; held back one chunk. */
  private var pendingCR = false
  /** `TextDecoder` drops a byte-order mark at the start of a byte stream. */
  private var sawBytes = false
  private var lastSeq = -1

  /** The cursor to resume from: the highest `id:` seen, `-1` before any. */
  public val cursor: Int get() = lastSeq

  public fun push(bytes: ByteArray): List<StreamFrame> {
    var chunk = bytes
    if (!sawBytes && chunk.isNotEmpty()) {
      sawBytes = true
      if (chunk.size >= 3 && chunk[0] == 0xEF.toByte() && chunk[1] == 0xBB.toByte() && chunk[2] == 0xBF.toByte()) {
        chunk = chunk.copyOfRange(3, chunk.size)
      }
    }
    append(chunk)
    return drain()
  }

  public fun push(text: String): List<StreamFrame> {
    append(text.toByteArray(Charsets.UTF_8))
    return drain()
  }

  /** End of stream. An event with no terminating blank line is discarded:
   *  half a `text-delta` is worse than a missing one. */
  public fun flush(): List<StreamFrame> {
    val frames = drain()
    buffer = ByteArrayOutputStream()
    pendingCR = false
    return frames
  }

  /** Normalises every line ending to `\n`. */
  private fun append(bytes: ByteArray) {
    if (bytes.isEmpty()) return
    var start = 0
    var end = bytes.size
    if (pendingCR) {
      buffer.write(LF)
      pendingCR = false
      if (bytes[0] == LF.toByte()) start = 1
    }
    if (end > start && bytes[end - 1] == CR.toByte()) {
      end -= 1
      pendingCR = true
    }
    var i = start
    while (i < end) {
      val byte = bytes[i]
      if (byte == CR.toByte()) {
        buffer.write(LF)
        if (i + 1 < end && bytes[i + 1] == LF.toByte()) i++
      } else {
        buffer.write(byte.toInt())
      }
      i++
    }
  }

  private fun drain(): List<StreamFrame> {
    val bytes = buffer.toByteArray()
    val frames = mutableListOf<StreamFrame>()
    var start = 0
    var i = 0
    while (i + 1 < bytes.size) {
      if (bytes[i] == LF.toByte() && bytes[i + 1] == LF.toByte()) {
        parse(bytes, start, i)?.let(frames::add)
        start = i + 2
        i = start
      } else {
        i++
      }
    }
    if (start > 0) {
      buffer = ByteArrayOutputStream().apply { write(bytes, start, bytes.size - start) }
    }
    return frames
  }

  private fun parse(bytes: ByteArray, from: Int, to: Int): StreamFrame? {
    var id: String? = null
    val data = mutableListOf<String>()

    val block = String(bytes, from, to - from, Charsets.UTF_8)
    for (line in block.split('\n')) {
      // A comment: the server's keepalive. Carries nothing.
      if (line.isEmpty() || line.startsWith(":")) continue
      val colon = line.indexOf(':')
      val field = if (colon == -1) line else line.substring(0, colon)
      var value = if (colon == -1) "" else line.substring(colon + 1)
      if (value.startsWith(" ")) value = value.substring(1)
      when (field) {
        "data" -> data.add(value)
        "id" -> id = value
        // `event:` and `retry:` are dropped: the frame's own `type` is the
        // discriminator.
      }
    }

    if (data.isEmpty()) return null
    // One unparseable frame must not take the rest of the run with it.
    val event =
      try {
        GemiJson.parseToJsonElement(data.joinToString("\n"))
      } catch (_: Exception) {
        return null
      }

    // A frame with no usable id continues the count: seq is the replay guard
    // downstream, so treating it as 0 would make it look already applied.
    val seq = id?.let(::number) ?: (lastSeq + 1)
    lastSeq = seq
    return StreamFrame(seq, event)
  }

  private companion object {
    const val LF = 0x0A
    const val CR = 0x0D

    /** `Number(id)` as JavaScript reads it, for the ids a server sends. */
    fun number(text: String): Int? {
      val trimmed = text.trim()
      if (trimmed.isEmpty()) return null
      val value = trimmed.toDoubleOrNull() ?: return null
      if (!value.isFinite()) return null
      return value.toLong().toInt()
    }
  }
}
