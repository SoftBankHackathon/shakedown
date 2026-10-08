FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY gradlew build.gradle settings.gradle ./
COPY gradle ./gradle
RUN chmod +x gradlew
COPY src ./src
RUN ./gradlew --no-daemon bootJar

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN groupadd --system board && useradd --system --gid board board
COPY --from=build --chown=board:board /src/build/libs/board.jar /app/board.jar
USER board
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70", "-jar", "/app/board.jar"]
