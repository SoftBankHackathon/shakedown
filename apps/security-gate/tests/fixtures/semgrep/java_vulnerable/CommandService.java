package example;

public class CommandService {
    public void execute(String command) throws java.io.IOException {
        Runtime.getRuntime().exec(command);
        new ProcessBuilder(command).start();
        Runtime runtime = Runtime.getRuntime();
        runtime.exec(command);
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.start();
        java.lang.Runtime.getRuntime().exec(command);
        new java.lang.ProcessBuilder(command).start();
    }
}
