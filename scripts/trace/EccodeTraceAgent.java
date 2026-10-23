// Runtime class-load tracer (JVM: Java and Kotlin bytecode). Compiled once into
// a cached agent jar and attached through JAVA_TOOL_OPTIONS=-javaagent by
// `eccode impact --trace`: every in-project class the traced command loads -
// Class.forName, reflection, ServiceLoader and plain first use alike - is
// appended to ECCODE_TRACE_FILE with the nearest in-project class on the stack
// that caused the load. The impact merge maps class names back to source files.
import java.io.FileOutputStream;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.security.CodeSource;
import java.security.ProtectionDomain;

public final class EccodeTraceAgent implements ClassFileTransformer {
    private final String out;
    private final String root;

    private EccodeTraceAgent(String out, String root) {
        this.out = out;
        this.root = root;
    }

    public static void premain(String args, Instrumentation inst) {
        String out = System.getenv("ECCODE_TRACE_FILE");
        String root = System.getenv("ECCODE_TRACE_ROOT");
        if (out == null || root == null) return;
        inst.addTransformer(new EccodeTraceAgent(out, root.replace('\\', '/')));
    }

    private boolean inProject(ProtectionDomain pd) {
        try {
            CodeSource cs = pd == null ? null : pd.getCodeSource();
            if (cs == null || cs.getLocation() == null) return false;
            String loc = Paths.get(cs.getLocation().toURI()).toString().replace('\\', '/');
            return (loc + "/").startsWith(root);
        } catch (Throwable t) {
            return false;
        }
    }

    @Override
    public byte[] transform(ClassLoader loader, String className, Class<?> redefined, ProtectionDomain pd, byte[] bytes) {
        try {
            if (className == null || !inProject(pd)) return null;
            String from = StackWalker.getInstance(StackWalker.Option.RETAIN_CLASS_REFERENCE).walk(frames -> frames
                .filter(f -> f.getDeclaringClass() != EccodeTraceAgent.class)
                .filter(f -> inProject(f.getDeclaringClass().getProtectionDomain()))
                .map(f -> f.getClassName().replace('.', '/'))
                .filter(n -> !n.equals(className))
                .findFirst().orElse(null));
            StringBuilder line = new StringBuilder("{\"toClass\":\"").append(escape(className)).append('"');
            if (from != null) line.append(",\"fromClass\":\"").append(escape(from)).append('"');
            line.append("}\n");
            synchronized (EccodeTraceAgent.class) {
                try (FileOutputStream f = new FileOutputStream(out, true)) {
                    f.write(line.toString().getBytes(StandardCharsets.UTF_8));
                }
            }
        } catch (Throwable t) {
            // tracing must never break the traced program
        }
        return null; // never changes the class
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
