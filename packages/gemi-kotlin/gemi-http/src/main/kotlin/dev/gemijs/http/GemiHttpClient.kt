package dev.gemijs.http

import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** Supply the API base URL, including its /api prefix. */
public class GemiHttpClient(baseUrl: String) {
  private val base = baseUrl.toHttpUrl()
  private val json = Json { ignoreUnknownKeys = true }

  public suspend fun <Body, Output, Failure> patch(
    segments: List<String>, body: Body, input: SerializationStrategy<Body>,
    output: DeserializationStrategy<Output>, rejection: DeserializationStrategy<Failure>,
    status: Int, exception: (Failure) -> Exception,
  ): Output {
    val url = base.newBuilder().apply {
      for (segment in segments) {
        require(segment.isNotEmpty() && segment != "." && segment != "..") { "Invalid path segment" }
        addPathSegment(segment)
      }
    }.build()
    val request = Request.Builder().url(url)
      .patch(json.encodeToString(input, body).toRequestBody("application/json".toMediaType()))
      .build()
    val (code, data) = client.newCall(request).readResponse()
    if (code in 200..299) return json.decodeFromString(output, data)
    if (code == status) {
      // The route's error fields are wrapped; the status normally comes from HTTP.
      val typed = try {
        val envelope = json.parseToJsonElement(data) as? JsonObject
        (envelope?.get("error") as? JsonObject)?.let { fields ->
          val withStatus = JsonObject(mapOf("status" to JsonPrimitive(code)) + fields)
          json.decodeFromJsonElement(rejection, withStatus)
        }
      } catch (_: SerializationException) { null }
      if (typed != null) throw exception(typed)
    }
    throw GemiHttpStatusException(code, data)
  }

  private companion object {
    val client = OkHttpClient.Builder().retryOnConnectionFailure(false).followRedirects(false).build()
  }
}

public class GemiHttpStatusException(public val status: Int, public val body: String) :
  IOException("HTTP $status")

private suspend fun Call.readResponse(): Pair<Int, String> = suspendCancellableCoroutine { continuation ->
  continuation.invokeOnCancellation { cancel() }
  enqueue(object : Callback {
    override fun onResponse(call: Call, response: Response) {
      try {
        continuation.resume(response.use { it.code to it.body.string() })
      } catch (e: IOException) {
        continuation.resumeWithException(e)
      }
    }

    override fun onFailure(call: Call, e: IOException) {
      continuation.resumeWithException(e)
    }
  })
}
