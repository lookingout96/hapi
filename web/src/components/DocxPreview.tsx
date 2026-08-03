import { useEffect, useState } from 'react'
import * as mammoth from 'mammoth'

function decodeBase64Buffer(content: string): ArrayBuffer {
    const binary = atob(content)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
    }
    return bytes.buffer
}

export function DocxPreview(props: { content: string; fileName: string }) {
    const [html, setHtml] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setHtml(null)
        setError(null)

        const convertDocument = async () => {
            try {
                const result = await mammoth.convertToHtml({ arrayBuffer: decodeBase64Buffer(props.content) })
                if (!cancelled) setHtml(result.value)
            } catch (cause) {
                if (!cancelled) {
                    setError(cause instanceof Error ? cause.message : 'Unable to preview Word document')
                }
            }
        }

        void convertDocument()
        return () => {
            cancelled = true
        }
    }, [props.content])

    if (error) return <div className="text-sm text-[var(--app-hint)]">{error}</div>
    if (html === null) return <div className="text-sm text-[var(--app-hint)]">Loading document preview...</div>

    const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><style>body{box-sizing:border-box;max-width:52rem;margin:0 auto;padding:2rem;font:16px/1.6 system-ui,sans-serif;color:#202124;background:#fff}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ddd;padding:.4rem}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`

    return (
        <iframe
            title={`Preview of ${props.fileName}`}
            sandbox=""
            srcDoc={documentHtml}
            className="h-[70vh] min-h-96 w-full rounded-md border border-[var(--app-border)] bg-white"
        />
    )
}
