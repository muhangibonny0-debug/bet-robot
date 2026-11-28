# BetRobot Optional Google Cloud Run Container (NOT deployed automatically)
FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY research/package.json research/package-lock.json* ./research/
RUN cd research && npm install --omit=dev

COPY research ./research
COPY cloud ./cloud

ENV NODE_ENV=production \
    PORT=8080 \
    BETROBOT_STATE_DIR=/tmp/betrobot_state \
    MAX_CONCURRENT_JOBS=1 \
    MAX_JOBS_PER_DAY=10 \
    MAX_JOBS_PER_MONTH=100 \
    MAX_JOB_MINUTES=15 \
    MAX_ACTIVE_MINUTES_PER_DAY=90 \
    BOT_CONCURRENCY=2

RUN mkdir -p /tmp/betrobot_state && chown -R pwuser:pwuser /app /tmp/betrobot_state
USER pwuser

EXPOSE 8080
CMD ["node", "cloud/server.js"]
