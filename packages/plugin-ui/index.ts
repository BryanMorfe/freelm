/** FreeLM supplies this module inside an isolated plugin tab or drawer view. */
import type { JSONValue, Disposable } from '../plugin-sdk';
import { createPluginUIBridge } from './bridge';
const bridge = createPluginUIBridge();

/** API v1 account-bound action. Declared actions and account grants are enforced by FreeLM. */
export function invoke(action: string, args: Record<string, JSONValue> = {}): Promise<JSONValue> {
    return bridge.invoke(action, args) as Promise<JSONValue>;
}
/** API v2 scoped service call. Views have exactly their parent activation's grants and ownership. */
export function call<T = JSONValue>(method: string, args: Record<string, JSONValue> = {}): Promise<T> {
    return bridge.call(method, args) as Promise<T>;
}
/** Execute a command registered by this view's owning activation. */
export function runCommand(id: string, payload: Record<string, JSONValue> = {}): Promise<void> {
    return bridge.runCommand(id, payload).then(() => undefined);
}
export function getViewProps<T extends Record<string, unknown> = Record<string, JSONValue>>(): T {
    return bridge.getViewProps() as T;
}
export function onViewPropsChanged<T extends Record<string, unknown> = Record<string, JSONValue>>(callback: (props: T) => void): Disposable {
    return bridge.onViewPropsChanged(callback as (props: Record<string, unknown>) => void);
}
