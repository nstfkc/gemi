package dev.gemijs.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

// The transcript is kept as the JSON the server sent, with typed views over it
// (`Models.kt`), rather than decoded into data classes. In stateless mode the
// client posts its history back verbatim and the server leans on members a UI
// never reads — a reasoning item's `id`, the signatures on pending calls and
// parked sub-runs, their `path` — and a data class drops whatever it does not
// declare. Here a member the server adds tomorrow survives the round trip.

/**
 * The one `Json` this library encodes and decodes with, generated types
 * included.
 *
 * `encodeDefaults = false` with `explicitNulls = true` is what keeps optional
 * and nullable apart: a generated optional property defaults to `null` and is
 * left out, while a required nullable one has no default and is written as
 * `null` — the server's schema needs the key present.
 */
public val GemiJson: Json = Json {
  ignoreUnknownKeys = true
  encodeDefaults = false
  explicitNulls = true
}

internal fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

internal fun JsonElement?.bool(): Boolean? =
  (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

internal fun JsonElement?.int(): Int? =
  (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.let { value ->
    value.toInt().takeIf { it.toDouble() == value }
  }

internal fun JsonElement?.array(): JsonArray? = this as? JsonArray

internal fun JsonElement?.obj(): JsonObject? = this as? JsonObject

internal fun JsonObject.string(key: String): String? = this[key].string()

/** A copy with `key` set, or removed when `value` is Kotlin `null`. */
internal fun JsonObject.with(key: String, value: JsonElement?): JsonObject =
  JsonObject(if (value == null) this - key else this + (key to value))

internal fun jsonObjectOf(vararg pairs: Pair<String, JsonElement?>): JsonObject =
  JsonObject(pairs.mapNotNull { (key, value) -> value?.let { key to it } }.toMap())

internal fun String?.json(): JsonElement? = this?.let(::JsonPrimitive)

/** JavaScript's `??` treats `null` as missing too. */
internal fun JsonElement?.nonNull(): JsonElement? = this?.takeIf { it !is JsonNull }

/** JavaScript truthiness, for the one place the port needs it. */
internal fun JsonElement.truthy(): Boolean =
  when (this) {
    is JsonNull -> false
    is JsonPrimitive ->
      if (isString) content.isNotEmpty()
      else booleanOrNull ?: (doubleOrNull?.let { it != 0.0 && !it.isNaN() } ?: true)
    else -> true
  }

/**
 * Structural equality as JSON means it: numbers by value, so `4` and `4.0`
 * are one number, and object keys in any order.
 */
public fun jsonEquals(a: JsonElement?, b: JsonElement?): Boolean =
  when {
    a == null || b == null -> a == b
    a is JsonObject && b is JsonObject ->
      a.keys == b.keys && a.keys.all { jsonEquals(a[it], b[it]) }
    a is JsonArray && b is JsonArray -> a.size == b.size && a.indices.all { jsonEquals(a[it], b[it]) }
    a is JsonNull || b is JsonNull -> a is JsonNull && b is JsonNull
    a is JsonPrimitive && b is JsonPrimitive ->
      if (a.isString || b.isString) a.isString == b.isString && a.content == b.content
      else a.doubleOrNull?.let { it == b.doubleOrNull } ?: (a.contentOrNull == b.contentOrNull)
    else -> false
  }
