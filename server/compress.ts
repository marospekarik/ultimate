import { constants, createBrotliCompress, createGzip } from 'node:zlib'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { proxied } from './request-security.ts'

const compressible =
  /^(text\/(?!event-stream)|application\/(javascript|json|manifest\+json)|image\/svg\+xml)/

/**
 * Compress the response of a remote client (one that came through Tailscale Serve or from a non-loopback address) with
 * Brotli or gzip. Unbundled dev modules and the models list are large plain text, and a phone link pays for every
 * byte. Loopback clients, event streams, other types, small bodies and non-200 answers (304) are left alone.
 */
export function compress(request: IncomingMessage, response: ServerResponse) {
  const local =
    !proxied(request.headers) &&
    /^(::1|127\.|::ffff:127\.)/.test(request.socket.remoteAddress ?? '')
  const accepted = request.headers['accept-encoding'] ?? ''
  const encoding = /\bbr\b/.test(accepted) ? 'br' : /\bgzip\b/.test(accepted) ? 'gzip' : undefined
  if (local || !encoding || request.method === 'HEAD') return
  const raw = {
    writeHead: response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse,
    write: response.write.bind(response) as (chunk: unknown) => boolean,
    end: response.end.bind(response) as () => ServerResponse,
  }
  let stream: ReturnType<typeof createGzip> | undefined
  response.writeHead = (status: number, ...rest: unknown[]) => {
    // Move the headers passed here onto the response, so one case-insensitive store holds them all.
    const headers = rest.find((value) => typeof value === 'object') as
      | OutgoingHttpHeaders
      | undefined
    for (const [name, value] of Object.entries(headers ?? {}))
      if (value !== undefined) response.setHeader(name, value)
    if (
      status === 200 &&
      compressible.test(String(response.getHeader('content-type') ?? '')) &&
      !response.hasHeader('content-encoding') &&
      Number(response.getHeader('content-length') ?? Infinity) > 1024
    ) {
      // The weak ETag Vite sends stays: it names the resource, and revalidation needs it.
      response.removeHeader('content-length')
      response.setHeader('content-encoding', encoding)
      response.appendHeader('vary', 'Accept-Encoding')
      stream =
        encoding === 'br'
          ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
          : createGzip()
      stream.on('data', (chunk: Buffer) => {
        if (raw.write(chunk)) return
        stream?.pause()
        response.once('drain', () => stream?.resume())
      })
      stream.on('end', () => raw.end())
    }
    return raw.writeHead(status, ...rest.filter((value) => typeof value === 'string'))
  }
  // Node sends headers implicitly on the first write or end; do it now, through the override above.
  const open = () => {
    if (!response.headersSent) response.writeHead(response.statusCode)
  }
  response.write = (chunk: unknown) => {
    open()
    return stream ? stream.write(chunk) : raw.write(chunk)
  }
  response.end = ((chunk?: unknown) => {
    open()
    if (!stream) {
      if (chunk !== undefined) raw.write(chunk)
      return raw.end()
    }
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) stream.end(chunk)
    else stream.end()
    return response
  }) as typeof response.end
}
