import logging

from dotenv import load_dotenv

from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    RoomOutputOptions,
    StopResponse,
    WorkerOptions,
    cli,
    llm,
)
from livekit.plugins import assemblyai

from websocket_server import broadcast_transcript, start_websocket_server

load_dotenv()

logger = logging.getLogger("transcriber")


class Transcriber(Agent):
    def __init__(self):
        super().__init__(
            instructions="not-needed",
            stt=assemblyai.STT(),
        )

    async def on_user_turn_completed(
        self, chat_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ):
        # Add any backend processing of transcripts here if needed
        user_transcript = new_message.text_content
        logger.info(f" -> {user_transcript}")

        # Broadcast the transcript to every connected frontend client.
        await broadcast_transcript(user_transcript)

        # Needed to stop the agent's default conversational loop
        raise StopResponse()


async def entrypoint(ctx: JobContext):
    logger.info(
        f"starting transcriber (speech to text) example, room: {ctx.room.name}"
    )
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    session = AgentSession()

    await session.start(
        agent=Transcriber(),
        room=ctx.room,
        room_output_options=RoomOutputOptions(
            # If you don't want to send the transcription back to the room,
            # set this to False
            transcription_enabled=True,
            audio_enabled=False,
        ),
    )


if __name__ == "__main__":
    # Start the websocket broadcast server in a background thread BEFORE
    # the LiveKit worker takes over the main thread.
    start_websocket_server(host="0.0.0.0", port=8001)

    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
