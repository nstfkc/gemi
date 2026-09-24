package dev.gemijs.chat

import kotlin.test.Test
import kotlin.test.assertEquals

// Ids the recorded cases cannot hold: the TypeScript reads them as a JavaScript
// number would, and these are where an `Int` has to part from it.

private fun seqs(vararg ids: String): List<Int> {
  val decoder = SSEFrameDecoder()
  return ids.flatMap { decoder.push("id: $it\ndata: {}\n\n") }.map { it.seq }
}

class SSEFrameIdTest {
  @Test
  fun anIdPastIntContinuesTheCount() {
    assertEquals(listOf(5, 6), seqs("5", "3000000000"))
    assertEquals(listOf(Int.MAX_VALUE), seqs("2147483647"))
  }

  @Test
  fun anIdIsADecimalNumberNotAJavaLiteral() {
    assertEquals(listOf(5, 6, 7, 8), seqs("5", "7f", "1d", "0x1p3"))
    assertEquals(listOf(12, 400), seqs(" 12 ", "4e2"))
  }
}
