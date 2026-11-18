// Generated from bin/http-client/__fixtures__/notes.ts#default. Do not edit.
package dev.gemijs.chat.generated

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

@Serializable
public data class PATCHNotesIdParams(
  public val id: String,
)

@Serializable
public data class PATCHNotesIdInput(
  public val title: String,
)

@Serializable
public data class PATCHNotesIdResponse(
  public val id: String,
  public val title: String,
)

@Serializable
public data class PATCHNotesIdError(
  public val kind: PATCHNotesIdErrorKind,
  public val status: PATCHNotesIdErrorStatus,
)

@Serializable(with = PATCHNotesIdErrorKind.Serializer::class)
public data object PATCHNotesIdErrorKind {
  public object Serializer : KSerializer<PATCHNotesIdErrorKind> {
    override val descriptor = String.serializer().descriptor
    override fun deserialize(decoder: Decoder): PATCHNotesIdErrorKind {
      if (decoder.decodeString() != "empty_title") throw SerializationException("Unexpected PATCHNotesIdErrorKind")
      return PATCHNotesIdErrorKind
    }
    override fun serialize(encoder: Encoder, value: PATCHNotesIdErrorKind) = encoder.encodeString("empty_title")
  }
}

@Serializable(with = PATCHNotesIdErrorStatus.Serializer::class)
public data object PATCHNotesIdErrorStatus {
  public object Serializer : KSerializer<PATCHNotesIdErrorStatus> {
    override val descriptor = Double.serializer().descriptor
    override fun deserialize(decoder: Decoder): PATCHNotesIdErrorStatus {
      if (decoder.decodeDouble() != 422.0) throw SerializationException("Unexpected PATCHNotesIdErrorStatus")
      return PATCHNotesIdErrorStatus
    }
    override fun serialize(encoder: Encoder, value: PATCHNotesIdErrorStatus) = encoder.encodeDouble(422.0)
  }
}
