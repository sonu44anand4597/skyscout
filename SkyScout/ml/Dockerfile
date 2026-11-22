# Build from the application root: docker build -f ml/Dockerfile .
FROM python:3.14.6-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/ml
COPY ml/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY ml/app.py ml/train.py ml/india_support.py ./
COPY backend/data/airport-locations.json /app/backend/data/airport-locations.json
RUN useradd --create-home --uid 10001 inference
USER inference
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/readyz', timeout=3)"
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
