FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /streamdrop .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /streamdrop /streamdrop
ENTRYPOINT ["/streamdrop", "-addr", "0.0.0.0:8080"]
