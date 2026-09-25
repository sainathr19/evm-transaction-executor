import { InvalidInputRpcError, RpcRequestError, TimeoutError } from 'viem'

/** A JSON-RPC error answer from a node, shaped the way viem reports anvil's rejections. */
export function nodeError(message: string) {
  return new InvalidInputRpcError(
    new RpcRequestError({ body: {}, error: { code: -32003, message }, url: 'http://node' }),
  )
}

/** A send the node never answered. */
export function timeoutError() {
  return new TimeoutError({ body: {}, url: 'http://node' })
}
