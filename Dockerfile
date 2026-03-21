# Builder stage to install dependencies and the wheel
FROM python:3.13-slim AS builder

# Set working directory for builder
WORKDIR /app

# Install build and runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    build-essential \
    gcc \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Copy the built Python wheel
COPY dist/*.whl .

# Install the Python package
RUN pip install --no-cache-dir *.whl

# Final stage with minimal runtime dependencies
FROM python:3.13-slim

# Set working directory
WORKDIR /app

# Install only runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libffi8 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy the installed Python environment and neat-insight binaries from the builder
COPY --from=builder /usr/local/lib/python3.13 /usr/local/lib/python3.13
COPY --from=builder /usr/local/bin /usr/local/bin
COPY neat_insight/bin /app/neat_insight/bin

# Expose required ports
EXPOSE 9900 9000-9079 9100-9179 8081 8554

# Set environment variables for Flask (used by neat_insight.app:main)
ENV FLASK_APP=neat_insight.app

# Run the neat-insight application
CMD ["neat-insight"]
