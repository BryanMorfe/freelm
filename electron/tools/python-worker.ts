/** Embedded so the signed Electron bundle owns the worker without an external script path. */
export const pythonWorkerSource = String.raw`
import ast, contextlib, ctypes, errno, io, json, os, platform, resource, signal, sys, traceback

protocol = sys.stdout
output_dir = os.path.realpath(sys.argv[1])
os.chdir(output_dir)
os.environ['HOME'] = output_dir
os.environ['TMPDIR'] = output_dir
os.environ['MPLCONFIGDIR'] = output_dir
os.environ['MPLBACKEND'] = 'Agg'
for variable in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'BLIS_NUM_THREADS'):
    os.environ[variable] = '1'
resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
try:
    resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
except (ValueError, OSError):
    pass

def linux_seccomp():
    # The filesystem/network boundary is bubblewrap. This irreversible filter also
    # prevents launching commands or creating child interpreters after bootstrap.
    arch = platform.machine()
    if arch == 'x86_64':
        audit_arch = 0xc000003e
        denied = [41, 42, 43, 49, 50, 53, 56, 57, 58, 59, 101, 272, 288, 308, 322, 435]
    elif arch in ('aarch64', 'arm64'):
        audit_arch = 0xc00000b7
        denied = [97, 117, 198, 199, 200, 201, 202, 203, 220, 221, 242, 268, 281, 435]
    else:
        raise RuntimeError('Python isolation does not support this Linux architecture.')
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
    instructions = [Filter(0x20, 0, 0, 4), Filter(0x15, 1, 0, audit_arch), Filter(0x06, 0, 0, 0x80000000), Filter(0x20, 0, 0, 0)]
    if arch == 'x86_64':
        # Reject the x32 ABI rather than allow alternate syscall numbers.
        instructions += [Filter(0x45, 0, 1, 0x40000000), Filter(0x06, 0, 0, 0x80000000)]
    for number in denied:
        instructions += [Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM)]
    instructions.append(Filter(0x06, 0, 0, 0x7fff0000))
    array = (Filter * len(instructions))(*instructions)
    program = Program(len(instructions), array)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
        raise RuntimeError('Python seccomp isolation could not be enabled.')

if sys.platform == 'linux':
    linux_seccomp()

def forbid_processes(event, args):
    if event in ('subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn', 'os.fork', 'os.forkpty'):
        raise PermissionError('Commands and child processes are unavailable in Chat Python.')
sys.addaudithook(forbid_processes)

class Capture(io.TextIOBase):
    def __init__(self):
        self.parts = []
        self.remaining = 65536
        self.truncated = False
    def write(self, value):
        value = str(value)
        selected = value[:self.remaining]
        if selected:
            self.parts.append(selected)
        self.remaining -= len(selected)
        self.truncated |= len(selected) < len(value)
        return len(value)
    def flush(self):
        pass
    def text(self):
        return ''.join(self.parts) + ('\n[Output truncated.]' if self.truncated else '')

def emit(value):
    protocol.write(json.dumps(value, ensure_ascii=True) + '\n')
    protocol.flush()

execution_timed_out = False
def deadline(signum, frame):
    global execution_timed_out
    execution_timed_out = True
    raise TimeoutError('Python execution timed out; the interpreter will be reset.')
signal.signal(signal.SIGALRM, deadline)

namespace = {'__name__': '__main__'}
try:
    import importlib.util
    libraries = [name for name in ('numpy', 'pandas', 'matplotlib', 'sympy', 'PIL') if importlib.util.find_spec(name)]
    emit({'type': 'ready', 'python': platform.python_version(), 'libraries': libraries})
except BaseException as error:
    emit({'type': 'startup_error', 'error': str(error)[:4096]})
    sys.exit(1)

for line in sys.stdin:
    if len(line) > 200000:
        sys.exit(1)
    command = json.loads(line)
    stdout, stderr = Capture(), Capture()
    result, error = '', ''
    execution_timed_out = False
    signal.setitimer(signal.ITIMER_REAL, command['timeout_ms'] / 1000)
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            tree = ast.parse(command['code'], filename='<chat-python>', mode='exec')
            final = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, '<chat-python>', 'exec'), namespace, namespace)
            if final is not None:
                value = eval(compile(ast.Expression(final.value), '<chat-python>', 'eval'), namespace, namespace)
                if value is not None:
                    namespace['_'] = value
                    result = repr(value)[:32768]
    except BaseException:
        error = traceback.format_exc(limit=8)[-8192:]
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    emit({'type': 'result', 'id': command['id'], 'stdout': stdout.text(), 'stderr': stderr.text(), 'result': result, 'error': error, 'timed_out': execution_timed_out})
`;
