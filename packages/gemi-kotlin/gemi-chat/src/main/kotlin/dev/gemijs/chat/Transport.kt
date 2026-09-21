package dev.gemijs.chat

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.job
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** A request `ChatSession` makes. Always a POST. */
public class ChatRequest(
  public val url: String,
  public val headers: Map<String, String>,
  public val body: ByteArray,
  public val contentType: String,
)

public class ChatResponse(public val statusCode: Int, public val body: Flow<ByteArray>) {
  public val isSuccess: Boolean get() = statusCode in 200..299

  /** The whole body, for the responses that are not streams. */
  public suspend fun bytes(): ByteArray {
    var all = ByteArray(0)
    body.collect { all += it }
    return all
  }
}

/**
 * What `ChatSession` sends requests through.
 *
 * `OkHttpTransport` is the one an app uses. The seam exists so a test can
 * stand in for the server, and so an app with its own networking stack can put
 * it underneath.
 */
public interface ChatTransport {
  /**
   * Sends the request. The body is streamed: the agent routes answer with SSE,
   * and a turn's frames have to reach the transcript as they arrive.
   *
   * Cancelling the calling coroutine — or the one collecting the body — must
   * close the connection. That is what `stop()` relies on to stop the UI at
   * once, before the server has even been told.
   */
  public suspend fun send(request: ChatRequest): ChatResponse
}

/** `ChatTransport` over OkHttp. */
public class OkHttpTransport(
  private val client: OkHttpClient =
    OkHttpClient.Builder()
      // Between two frames, not for the whole stream: a model thinking before
      // it speaks is silent for a while, and the server's keepalives are what
      // keep this from firing on a live run.
      .readTimeout(60, TimeUnit.SECONDS)
      .build()
) : ChatTransport {
  override suspend fun send(request: ChatRequest): ChatResponse {
    val call =
      client.newCall(
        Request.Builder()
          .url(request.url)
          .apply { request.headers.forEach { (key, value) -> header(key, value) } }
          .post(request.body.toRequestBody(request.contentType.toMediaType()))
          .build()
      )
    val response = call.await()
    val body =
      flow {
          // Closing the call is the only thing that interrupts a blocking read.
          currentCoroutineContext().job.invokeOnCompletion { call.cancel() }
          response.use {
            val source = it.body.source()
            val buffer = ByteArray(8192)
            while (true) {
              val read = source.inputStream().read(buffer)
              if (read == -1) break
              emit(buffer.copyOf(read))
            }
          }
        }
        .flowOn(Dispatchers.IO)
    return ChatResponse(response.code, body)
  }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
  continuation.invokeOnCancellation { cancel() }
  enqueue(
    object : Callback {
      override fun onResponse(call: Call, response: Response) {
        continuation.resume(response) { _, value, _ -> value.close() }
      }

      override fun onFailure(call: Call, e: IOException) {
        continuation.resumeWithException(e)
      }
    }
  )
}
