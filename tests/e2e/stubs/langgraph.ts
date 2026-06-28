// Browser stub for @assistant-ui/react-langgraph. The real
// useLangGraphSendCommand reads from a React Context the runtime
// provides; we replace it with a function that forwards to the
// global __cryptoSendCommand shim installed by harness.tsx.

export function useLangGraphSendCommand() {
  return (cmd: { resume: string }) => {
    const fn = (globalThis as unknown as { __cryptoSendCommand?: (c: { resume: string }) => void })
      .__cryptoSendCommand;
    fn?.(cmd);
  };
}
