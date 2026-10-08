FROM eclipse-temurin:21-jdk AS build
WORKDIR /build
COPY . .
RUN chmod +x gradlew && ./gradlew --no-daemon bootJar

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN groupadd --system board && useradd --system --gid board board
COPY --from=build /build/build/libs/*-SNAPSHOT.jar app.jar
USER board
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
