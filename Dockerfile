# syntax=docker/dockerfile:1
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-editable \
    && groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FLIGHTY_TRANSPORT=streamable-http \
    FLIGHTY_HOST=0.0.0.0 \
    FLIGHTY_PORT=8000
USER 10001:10001
EXPOSE 8000
LABEL org.opencontainers.image.title="flighty-mcp" \
      org.opencontainers.image.description="Unofficial Flighty MCP server" \
      org.opencontainers.image.source="https://github.com/swiftyspiffy/flighty-mcp" \
      org.opencontainers.image.licenses="MIT"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -m flighty_mcp.healthcheck
ENTRYPOINT ["flighty-mcp"]
