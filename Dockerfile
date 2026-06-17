FROM python:3.12-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=5000 \
    HOMEPAGE_CONFIG_DIR=/config \
    PYTHONUNBUFFERED=1

EXPOSE 5000

# A single worker keeps file writes serialized; the workload is tiny.
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "--timeout", "60", "app:app"]
