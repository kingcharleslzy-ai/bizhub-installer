FROM python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134 AS runtime

ARG BIZHUB_CORE_COMMIT=development
ARG BIZHUB_CORE_ARTIFACT_DIGEST

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BIZHUB_GENERIC_DATABASE_PATH=/data/bizhub.db \
    BIZHUB_ADMIN_CONFIG=/data/admin.json \
    BIZHUB_COMPANY_CONFIG=/config/company.json \
    BIZHUB_SECRET_KEY_FILE=/config/secret-key \
    BIZHUB_COMMON_ROOT=/opt/bizhub \
    BIZHUB_COMMON_MANIFEST=/opt/bizhub/bizhub-common-manifest.json \
    BIZHUB_CORE_COMMIT=${BIZHUB_CORE_COMMIT} \
    BIZHUB_CORE_ARTIFACT_DIGEST=${BIZHUB_CORE_ARTIFACT_DIGEST}

LABEL org.opencontainers.image.revision=${BIZHUB_CORE_COMMIT} \
      com.bizhub.core.artifact.digest=${BIZHUB_CORE_ARTIFACT_DIGEST} \
      com.bizhub.runtime.profile=generic-kernel-smoke

WORKDIR /opt/bizhub
RUN groupadd --gid 10001 bizhub && useradd --uid 10001 --gid bizhub --no-create-home --shell /usr/sbin/nologin bizhub
COPY backend/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

COPY vendor/bizhub-common.tar.gz /tmp/bizhub-common.tar.gz
COPY vendor/bizhub-common-manifest.json ./bizhub-common-manifest.json
RUN expected="${BIZHUB_CORE_ARTIFACT_DIGEST#sha256:}" \
    && test -n "$expected" \
    && echo "$expected  /tmp/bizhub-common.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/bizhub-common.tar.gz -C /opt/bizhub \
    && rm /tmp/bizhub-common.tar.gz

COPY runtime/bizhub ./bizhub
RUN mkdir -p /data /config /backups && chown -R bizhub:bizhub /opt/bizhub /data /config /backups
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"]
CMD ["uvicorn", "bizhub.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips=127.0.0.1"]
