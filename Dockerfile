FROM node:24-bookworm-slim AS frontend
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN node scripts/build-python-ui.mjs

FROM python:3.12-slim-bookworm AS runtime
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOST=0.0.0.0 PORT=8787 AEGIS_DATABASE_PATH=/app/data/aegis.sqlite AEGIS_FRONTEND_PATH=/app/dist/python-client
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
RUN useradd --uid 1000 --create-home aegis && mkdir -p /app/data && chown aegis:aegis /app/data
COPY --chown=aegis:aegis backend ./backend
COPY --chown=aegis:aegis drizzle ./drizzle
COPY --from=frontend --chown=aegis:aegis /app/dist/python-client ./dist/python-client
USER aegis
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["python", "backend/run.py"]
