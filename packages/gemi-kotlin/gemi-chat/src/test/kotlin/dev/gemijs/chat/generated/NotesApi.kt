// Generated from bin/http-client/__fixtures__/notes.ts#default. Do not edit.
package dev.gemijs.chat.generated

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Required
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

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
  @Required public val kind: PATCHNotesIdErrorKind = PATCHNotesIdErrorKind,
  @Required public val status: PATCHNotesIdErrorStatus = PATCHNotesIdErrorStatus,
)

@Serializable
public data class POSTNotesInput(
  public val note: String?,
  public val title: String? = null,
  @SerialName("wire-version") @Required public val wireVersion: POSTNotesInputWireVersion = POSTNotesInputWireVersion,
  @SerialName("wireVersion") public val wireVersion2: POSTNotesInputWireVersion2? = null,
  public val state: POSTNotesInputState? = null,
)

@Serializable
public enum class POSTNotesInputState {
  @SerialName("open") Open,
  @SerialName("closed") Closed,
}

@Serializable(with = POSTNotesResponse.Serializer::class)
public sealed interface POSTNotesResponse {
  public object Serializer : JsonContentPolymorphicSerializer<POSTNotesResponse>(POSTNotesResponse::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<POSTNotesResponse> =
      when (val value = element.jsonObject["ok"]) {
        JsonPrimitive(true) -> POSTNotesResponseTrue.serializer()
        JsonPrimitive(false) -> POSTNotesResponseFalse.serializer()
        else -> throw SerializationException("Unknown ok ${value ?: "missing"}")
      }
  }
}

@Serializable
public data class POSTNotesResponseTrue(
  @Required public val ok: POSTNotesResponseTrueOk = POSTNotesResponseTrueOk,
  public val tag: POSTNotesResponseTrueTag?,
  public val createdAt: JsonElement,
) : POSTNotesResponse

@Serializable
public data class POSTNotesResponseFalse(
  @Required public val ok: POSTNotesResponseFalseOk = POSTNotesResponseFalseOk,
  public val tag: POSTNotesResponseFalseTag?,
) : POSTNotesResponse

@Serializable(with = POSTNotesError.Serializer::class)
public sealed interface POSTNotesError {
  public object Serializer : JsonContentPolymorphicSerializer<POSTNotesError>(POSTNotesError::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<POSTNotesError> =
      when (val value = element.jsonObject["kind"]) {
        JsonPrimitive("empty_title") -> POSTNotesErrorEmptyTitle.serializer()
        JsonPrimitive("gone") -> POSTNotesErrorGone.serializer()
        else -> throw SerializationException("Unknown kind ${value ?: "missing"}")
      }
  }
}

@Serializable
public data class POSTNotesErrorEmptyTitle(
  @Required public val kind: POSTNotesErrorEmptyTitleKind = POSTNotesErrorEmptyTitleKind,
  @Required public val status: POSTNotesErrorEmptyTitleStatus = POSTNotesErrorEmptyTitleStatus,
) : POSTNotesError

@Serializable
public data class POSTNotesErrorGone(
  @Required public val kind: POSTNotesErrorGoneKind = POSTNotesErrorGoneKind,
  @Required public val status: POSTNotesErrorGoneStatus = POSTNotesErrorGoneStatus,
) : POSTNotesError

@Serializable(with = PATCHNotesIdErrorKind.Serializer::class)
public data object PATCHNotesIdErrorKind {
  public object Serializer : KSerializer<PATCHNotesIdErrorKind> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.PATCHNotesIdErrorKind", PrimitiveKind.STRING)
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
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.PATCHNotesIdErrorStatus", PrimitiveKind.DOUBLE)
    override fun deserialize(decoder: Decoder): PATCHNotesIdErrorStatus {
      if (decoder.decodeDouble() != 422.0) throw SerializationException("Unexpected PATCHNotesIdErrorStatus")
      return PATCHNotesIdErrorStatus
    }
    override fun serialize(encoder: Encoder, value: PATCHNotesIdErrorStatus) = encoder.encodeDouble(422.0)
  }
}

@Serializable(with = POSTNotesInputWireVersion.Serializer::class)
public data object POSTNotesInputWireVersion {
  public object Serializer : KSerializer<POSTNotesInputWireVersion> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesInputWireVersion", PrimitiveKind.DOUBLE)
    override fun deserialize(decoder: Decoder): POSTNotesInputWireVersion {
      if (decoder.decodeDouble() != 2.5) throw SerializationException("Unexpected POSTNotesInputWireVersion")
      return POSTNotesInputWireVersion
    }
    override fun serialize(encoder: Encoder, value: POSTNotesInputWireVersion) = encoder.encodeDouble(2.5)
  }
}

@Serializable(with = POSTNotesInputWireVersion2.Serializer::class)
public data object POSTNotesInputWireVersion2 {
  public object Serializer : KSerializer<POSTNotesInputWireVersion2> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesInputWireVersion2", PrimitiveKind.BOOLEAN)
    override fun deserialize(decoder: Decoder): POSTNotesInputWireVersion2 {
      if (decoder.decodeBoolean() != true) throw SerializationException("Unexpected POSTNotesInputWireVersion2")
      return POSTNotesInputWireVersion2
    }
    override fun serialize(encoder: Encoder, value: POSTNotesInputWireVersion2) = encoder.encodeBoolean(true)
  }
}

@Serializable(with = POSTNotesResponseTrueOk.Serializer::class)
public data object POSTNotesResponseTrueOk {
  public object Serializer : KSerializer<POSTNotesResponseTrueOk> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesResponseTrueOk", PrimitiveKind.BOOLEAN)
    override fun deserialize(decoder: Decoder): POSTNotesResponseTrueOk {
      if (decoder.decodeBoolean() != true) throw SerializationException("Unexpected POSTNotesResponseTrueOk")
      return POSTNotesResponseTrueOk
    }
    override fun serialize(encoder: Encoder, value: POSTNotesResponseTrueOk) = encoder.encodeBoolean(true)
  }
}

@Serializable(with = POSTNotesResponseTrueTag.Serializer::class)
public data object POSTNotesResponseTrueTag {
  public object Serializer : KSerializer<POSTNotesResponseTrueTag> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesResponseTrueTag", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): POSTNotesResponseTrueTag {
      if (decoder.decodeString() != "saved") throw SerializationException("Unexpected POSTNotesResponseTrueTag")
      return POSTNotesResponseTrueTag
    }
    override fun serialize(encoder: Encoder, value: POSTNotesResponseTrueTag) = encoder.encodeString("saved")
  }
}

@Serializable(with = POSTNotesResponseFalseOk.Serializer::class)
public data object POSTNotesResponseFalseOk {
  public object Serializer : KSerializer<POSTNotesResponseFalseOk> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesResponseFalseOk", PrimitiveKind.BOOLEAN)
    override fun deserialize(decoder: Decoder): POSTNotesResponseFalseOk {
      if (decoder.decodeBoolean() != false) throw SerializationException("Unexpected POSTNotesResponseFalseOk")
      return POSTNotesResponseFalseOk
    }
    override fun serialize(encoder: Encoder, value: POSTNotesResponseFalseOk) = encoder.encodeBoolean(false)
  }
}

@Serializable(with = POSTNotesResponseFalseTag.Serializer::class)
public data object POSTNotesResponseFalseTag {
  public object Serializer : KSerializer<POSTNotesResponseFalseTag> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesResponseFalseTag", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): POSTNotesResponseFalseTag {
      if (decoder.decodeString() != "saved") throw SerializationException("Unexpected POSTNotesResponseFalseTag")
      return POSTNotesResponseFalseTag
    }
    override fun serialize(encoder: Encoder, value: POSTNotesResponseFalseTag) = encoder.encodeString("saved")
  }
}

@Serializable(with = POSTNotesErrorEmptyTitleKind.Serializer::class)
public data object POSTNotesErrorEmptyTitleKind {
  public object Serializer : KSerializer<POSTNotesErrorEmptyTitleKind> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesErrorEmptyTitleKind", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): POSTNotesErrorEmptyTitleKind {
      if (decoder.decodeString() != "empty_title") throw SerializationException("Unexpected POSTNotesErrorEmptyTitleKind")
      return POSTNotesErrorEmptyTitleKind
    }
    override fun serialize(encoder: Encoder, value: POSTNotesErrorEmptyTitleKind) = encoder.encodeString("empty_title")
  }
}

@Serializable(with = POSTNotesErrorEmptyTitleStatus.Serializer::class)
public data object POSTNotesErrorEmptyTitleStatus {
  public object Serializer : KSerializer<POSTNotesErrorEmptyTitleStatus> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesErrorEmptyTitleStatus", PrimitiveKind.DOUBLE)
    override fun deserialize(decoder: Decoder): POSTNotesErrorEmptyTitleStatus {
      if (decoder.decodeDouble() != 422.0) throw SerializationException("Unexpected POSTNotesErrorEmptyTitleStatus")
      return POSTNotesErrorEmptyTitleStatus
    }
    override fun serialize(encoder: Encoder, value: POSTNotesErrorEmptyTitleStatus) = encoder.encodeDouble(422.0)
  }
}

@Serializable(with = POSTNotesErrorGoneKind.Serializer::class)
public data object POSTNotesErrorGoneKind {
  public object Serializer : KSerializer<POSTNotesErrorGoneKind> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesErrorGoneKind", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): POSTNotesErrorGoneKind {
      if (decoder.decodeString() != "gone") throw SerializationException("Unexpected POSTNotesErrorGoneKind")
      return POSTNotesErrorGoneKind
    }
    override fun serialize(encoder: Encoder, value: POSTNotesErrorGoneKind) = encoder.encodeString("gone")
  }
}

@Serializable(with = POSTNotesErrorGoneStatus.Serializer::class)
public data object POSTNotesErrorGoneStatus {
  public object Serializer : KSerializer<POSTNotesErrorGoneStatus> {
    override val descriptor = PrimitiveSerialDescriptor("dev.gemijs.chat.generated.POSTNotesErrorGoneStatus", PrimitiveKind.DOUBLE)
    override fun deserialize(decoder: Decoder): POSTNotesErrorGoneStatus {
      if (decoder.decodeDouble() != 410.0) throw SerializationException("Unexpected POSTNotesErrorGoneStatus")
      return POSTNotesErrorGoneStatus
    }
    override fun serialize(encoder: Encoder, value: POSTNotesErrorGoneStatus) = encoder.encodeDouble(410.0)
  }
}
