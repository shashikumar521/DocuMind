import re
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import (
    DEFAULT_TOP_K,
    EMBEDDING_MODEL,
    GEMINI_API_KEY,
    GEMINI_MODEL,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_MB,
    UPLOAD_DIR,
)
from .gemini_service import generate_rag_answer, generate_without_rag_answer
from .rag_pipeline import pipeline

app = FastAPI(title="DocuMind RAG API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    document_ids: Optional[List[str]] = None
    top_k: int = Field(default=DEFAULT_TOP_K, ge=1, le=15)


class CompareRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    document_ids: Optional[List[str]] = None
    top_k: int = Field(default=DEFAULT_TOP_K, ge=1, le=15)


def _sanitize_filename(name: str) -> str:
    base = Path(name or "document.pdf").name
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    return cleaned or "document.pdf"


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "backend": "python-fastapi",
        "vector_store": "chromadb",
        "embedding_model": EMBEDDING_MODEL,
        "gemini_model": GEMINI_MODEL,
        "gemini_configured": bool(GEMINI_API_KEY),
        "chunks_count": pipeline.collection.count(),
    }


@app.get("/api/documents")
def list_documents():
    return {"documents": pipeline.list_documents()}


@app.get("/api/documents/{document_id}")
def get_document(document_id: str):
    doc = pipeline.get_document(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found.")
    return {"document": doc}


@app.post("/api/documents/upload")
async def upload_documents(files: List[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="No PDF files were provided.")

    results = []
    for upload in files:
        filename = _sanitize_filename(upload.filename or "document.pdf")
        if not filename.lower().endswith(".pdf"):
            raise HTTPException(
                status_code=400,
                detail=f'"{filename}" is not a PDF file. Only .pdf files are supported.',
            )

        content = await upload.read()
        if len(content) == 0:
            raise HTTPException(status_code=400, detail=f'"{filename}" is empty.')
        if len(content) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f'"{filename}" exceeds the {MAX_UPLOAD_MB} MB upload limit.',
            )
        if not content.startswith(b"%PDF"):
            raise HTTPException(
                status_code=400,
                detail=f'"{filename}" is not a valid PDF binary.',
            )

        upload_root = UPLOAD_DIR.resolve()
        disk_name = f"{uuid.uuid4()}_{filename}"
        target_path = (upload_root / disk_name).resolve()
        if not target_path.is_relative_to(upload_root):
            raise HTTPException(status_code=400, detail="Invalid filename path.")

        target_path.write_bytes(content)
        try:
            doc = pipeline.process_pdf(target_path, filename, len(content), content)
            results.append(doc)
        except ValueError as err:
            target_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=str(err))
        except Exception as err:
            target_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Failed to index {filename}: {err}")

    return {"documents": results}


@app.delete("/api/documents/{document_id}")
def delete_document(document_id: str):
    deleted = pipeline.delete_document(document_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Document not found.")
    return {"deleted": True, "document_id": document_id}


@app.post("/api/chat/ask")
def ask_question(payload: AskRequest):
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    try:
        chunks = pipeline.retrieve_chunks(question, top_k=payload.top_k, document_ids=payload.document_ids)
        answer, prompt_preview = generate_rag_answer(question, chunks)
        pipeline.record_question(question, answer, chunks)
        return {
            "question": question,
            "answer": answer,
            "sources": chunks,
            "prompt_preview": prompt_preview,
        }
    except RuntimeError as err:
        raise HTTPException(status_code=503, detail=str(err))
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"Failed to generate answer: {err}")


@app.post("/api/chat/compare")
@app.post("/api/rag/compare")
def compare_rag(payload: CompareRequest):
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    try:
        chunks = pipeline.retrieve_chunks(question, top_k=payload.top_k, document_ids=payload.document_ids)
        without_rag = generate_without_rag_answer(question)
        with_rag, prompt_preview = generate_rag_answer(question, chunks)
        return {
            "question": question,
            "without_rag": {
                "answer": without_rag,
            },
            "with_rag": {
                "answer": with_rag,
                "sources": chunks,
                "prompt_preview": prompt_preview,
            },
        }
    except RuntimeError as err:
        raise HTTPException(status_code=503, detail=str(err))
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"Comparison failed: {err}")


@app.post("/api/retrieval/inspect")
def inspect_retrieval(payload: AskRequest):
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    try:
        chunks = pipeline.retrieve_chunks(question, top_k=payload.top_k, document_ids=payload.document_ids)
        answer, prompt_preview = generate_rag_answer(question, chunks)
        return {
            "question": question,
            "chunks": chunks,
            "prompt_preview": prompt_preview,
            "answer": answer,
        }
    except RuntimeError as err:
        raise HTTPException(status_code=503, detail=str(err))
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"Retrieval inspection failed: {err}")


@app.get("/api/chat/history")
def get_chat_history():
    return {"history": pipeline.get_history()}


@app.delete("/api/chat/history")
def clear_chat_history():
    pipeline.clear_history()
    return {"cleared": True}


@app.get("/api/dashboard/stats")
def dashboard_stats():
    return pipeline.get_dashboard_stats()
