import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

function decodeBase64Bytes(content: string): Uint8Array {
    const binary = atob(content)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
    }
    return bytes
}

const MAX_PDF_PREVIEW_BYTES = 50 * 1024 * 1024

function PdfPage(props: { page: PDFPageProxy; pageNumber: number; fileName: string }) {
    const containerRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const canvas = canvasRef.current
        const container = containerRef.current
        if (!canvas || !container) return

        let renderTask: RenderTask | null = null
        const canvasContext = canvas.getContext('2d')
        if (!canvasContext) {
            setError('Canvas rendering is unavailable')
            return
        }

        const baseViewport = props.page.getViewport({ scale: 1 })
        const scale = Math.min(2, container.clientWidth / baseViewport.width)
        const viewport = props.page.getViewport({ scale })
        const outputScale = window.devicePixelRatio || 1

        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`

        renderTask = props.page.render({
            canvasContext,
            transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
            viewport
        })
        void renderTask.promise.catch((cause: unknown) => {
            if (cause instanceof Error && cause.name === 'RenderingCancelledException') return
            setError(cause instanceof Error ? cause.message : 'Unable to render PDF page')
        })

        return () => renderTask?.cancel()
    }, [props.page])

    return (
        <div ref={containerRef} className="flex w-full justify-center">
            {error ? (
                <div className="text-sm text-[var(--app-hint)]">{error}</div>
            ) : (
                <canvas
                    ref={canvasRef}
                    aria-label={`Page ${props.pageNumber} of ${props.fileName}`}
                    className="max-w-full bg-white shadow-sm"
                />
            )}
        </div>
    )
}

export function PdfPreview(props: { content: string; fileName: string }) {
    const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
    const [pages, setPages] = useState<PDFPageProxy[]>([])
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        let loadedDocument: PDFDocumentProxy | null = null

        setDocument(null)
        setPages([])
        setError(null)

        if (props.content.length > MAX_PDF_PREVIEW_BYTES) {
            const sizeInMb = (props.content.length / (1024 * 1024)).toFixed(1)
            setError(`PDF is too large to preview (${sizeInMb} MB). Download the file to view it locally.`)
            return
        }

        const loadPdf = async () => {
            try {
                loadedDocument = await pdfjs.getDocument({ data: decodeBase64Bytes(props.content) }).promise
                const maxPages = Math.min(loadedDocument.numPages, 10)
                const loadedPages = await Promise.all(
                    Array.from({ length: maxPages }, (_, index) => loadedDocument!.getPage(index + 1))
                )
                if (cancelled) {
                    await loadedDocument.destroy()
                    return
                }
                setDocument(loadedDocument)
                setPages(loadedPages)
            } catch (cause) {
                if (!cancelled) {
                    setError(cause instanceof Error ? cause.message : 'Unable to preview PDF')
                }
            }
        }

        void loadPdf()
        return () => {
            cancelled = true
            if (loadedDocument) void loadedDocument.destroy()
        }
    }, [props.content])

    if (error) {
        return (
            <div className="flex min-h-48 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
                <div className="text-sm text-[var(--app-hint)]">{error}</div>
            </div>
        )
    }
    if (!document) {
        const sizeInMb = (props.content.length / (1024 * 1024)).toFixed(1)
        return (
            <div className="flex min-h-48 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
                <div className="text-sm text-[var(--app-hint)]">Loading PDF preview... ({sizeInMb} MB)</div>
            </div>
        )
    }

    return (
        <div className="flex min-h-48 flex-col items-center gap-4 overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
            {pages.map((page, index) => (
                <PdfPage key={page.pageNumber} page={page} pageNumber={index + 1} fileName={props.fileName} />
            ))}
        </div>
    )
}
