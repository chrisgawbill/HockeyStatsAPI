import anthropic
import sys
import json
import os
import logging

logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stderr)]
)
logger = logging.getLogger(__name__)

def call_claude(message):
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable not set")

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=os.environ.get("ANTHROPIC_MODEL"),
        max_tokens=2048,
        system="You are an expert in the NHL and the sport of hockey.",
        messages=[{"role": "user", "content": message}]
    )
    return response.content[0].text

if __name__ == "__main__":
    if len(sys.argv) < 2 or not sys.argv[1]:
        logger.error("No message was provided")
        sys.stdout.write(json.dumps({"error": "No message was provided"}))
        sys.exit(1)

    try:
        data = call_claude(sys.argv[1])
        sys.stdout.write(json.dumps({"data": data}))
    except Exception as e:
        logger.error("Error calling Claude: %s", str(e))
        sys.stdout.write(json.dumps({"error": str(e)}))
        sys.exit(1)
