FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS web
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134 AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BIZHUB_DATABASE_PATH=/data/bizhub.db \
    BIZHUB_COMPANY_CONFIG=/config/company.json \
    BIZHUB_SECRET_KEY_FILE=/config/secret-key \
    BIZHUB_STATIC_DIR=/opt/bizhub/bizhub/static
WORKDIR /opt/bizhub
RUN groupadd --gid 10001 bizhub && useradd --uid 10001 --gid bizhub --no-create-home --shell /usr/sbin/nologin bizhub
COPY backend/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY backend/bizhub ./bizhub
COPY --from=web /build/backend/bizhub/static ./bizhub/static
RUN mkdir -p /data /config /backups && chown -R bizhub:bizhub /opt/bizhub /data /config /backups
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"]
CMD ["uvicorn", "bizhub.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips=127.0.0.1"]
