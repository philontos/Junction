# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
FROM ${PYTHON_IMAGE} AS build
ENV PIP_DEFAULT_TIMEOUT=60 PIP_RETRIES=5
WORKDIR /build
COPY services/junction/pyproject.toml services/junction/requirements.lock ./
COPY services/junction/src ./src
COPY packages/agent-adapters/python ./agent-adapters
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip wheel --wheel-dir /wheels --constraint requirements.lock ./agent-adapters .

FROM ${PYTHON_IMAGE}
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN groupadd --gid 10001 junction && useradd --uid 10001 --gid 10001 --no-create-home junction
RUN --mount=type=bind,from=build,source=/wheels,target=/wheels \
    python -m pip install --no-cache-dir --no-index --find-links=/wheels junction-context
USER 10001:10001
WORKDIR /tmp
EXPOSE 8767
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8767/healthz', timeout=3).read()"]
ENTRYPOINT ["junction"]
CMD ["serve", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "8767"]
