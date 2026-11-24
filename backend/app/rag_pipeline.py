import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import chromadb
from pypdf import PdfReader
from sentence_transformers import SentenceTransformer

from .config import (
    CHROMA_PERSIST_DIR,
    CHUNK_OVERLAP_TOKENS,
    CHUNK_SIZE_TOKENS,
    DATA_DIR,
    EMBEDDING_MODEL,
    UPLOAD_DIR,
)

METADATA_FILE = DATA_DIR / "metadata.json"


try:
    import tiktoken
    _TOKENIZER = tiktoken.get_encoding("cl100k_base")
except Exception:
    _TOKENIZER = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def chunk_page_text(
    text: str,
    page_number: int,
    document_id: str,
    filename: str,
    chunk_size: int = CHUNK_SIZE_TOKENS,
    overlap: int = CHUNK_OVERLAP_TOKENS,
) -> List[Dict[str, Any]]:
    step = max(1, chunk_size - overlap)
    chunks: List[Dict[str, Any]] = []

    if _TOKENIZER is not None:
        tokens = _TOKENIZER.encode(text)
        if not tokens:
            return []
        idx = 0
        chunk_index = 0
        while idx < len(tokens):
            window = tokens[idx : idx + chunk_size]
            chunk_text = _TOKENIZER.decode(window).strip()
            if chunk_text:
                chunks.append(
                    {
                        "chunk_id": f"{document_id}_p{page_number}_c{chunk_index}",
                        "document_id": document_id,
                        "filename": filename,
                        "page_number": page_number,
                        "text": chunk_text,
                        "token_count": len(window),
                    }
                )
                chunk_index += 1
            if idx + chunk_size >= len(tokens):
                break
            idx += step
        return chunks

    words = re.findall(r"\S+", text)
    if not words:
        return []
    idx = 0
    chunk_index = 0
    while idx < len(words):
        window = words[idx : idx + chunk_size]
        chunk_text = " ".join(window).strip()
        if chunk_text:
            chunks.append(
                {
                    "chunk_id": f"{document_id}_p{page_number}_c{chunk_index}",
                    "document_id": document_id,
                    "filename": filename,
                    "page_number": page_number,
                    "text": chunk_text,
                    "token_count": len(window),
                }
            )
            chunk_index += 1
        if idx + chunk_size >= len(words):
            break
        idx += step

    return chunks


class RagPipeline:
    def __init__(self) -> None:
        self.chroma_client = chromadb.PersistentClient(path=str(CHROMA_PERSIST_DIR))
        self.collection = self.chroma_client.get_or_create_collection(
            name="documind_chunks",
            metadata={"hnsw:space": "cosine"},
        )
        self._embedder: Optional[SentenceTransformer] = None
        self._state = self._load_state()

    @property
    def embedder(self) -> SentenceTransformer:
        if self._embedder is None:
            self._embedder = SentenceTransformer(EMBEDDING_MODEL)
        return self._embedder

    def _load_state(self) -> Dict[str, Any]:
        if METADATA_FILE.exists():
            try:
                loaded = json.loads(METADATA_FILE.read_text(encoding="utf-8"))
                loaded.setdefault("documents", {})
                loaded.setdefault("conversations", [])
                loaded.setdefault("questions_answered", 0)
                loaded.setdefault("file_paths", {})
                return loaded
            except Exception:
                pass
        return {"documents": {}, "conversations": [], "questions_answered": 0, "file_paths": {}}

    def _save_state(self) -> None:
        METADATA_FILE.write_text(json.dumps(self._state, indent=2), encoding="utf-8")

    def list_documents(self) -> List[Dict[str, Any]]:
        docs = list(self._state["documents"].values())
        docs.sort(key=lambda d: d.get("uploaded_at", ""), reverse=True)
        return docs

    def get_document(self, document_id: str) -> Optional[Dict[str, Any]]:
        return self._state["documents"].get(document_id)

    def update_document_status(
        self,
        document_id: str,
        status: str,
        progress: int,
        error_message: Optional[str] = None,
        pages: Optional[int] = None,
        chunks_count: Optional[int] = None,
    ) -> None:
        doc = self._state["documents"].get(document_id)
        if not doc:
            return
        doc["status"] = status
        doc["progress"] = progress
        if error_message is not None:
            doc["error_message"] = error_message
        if pages is not None:
            doc["pages"] = pages
        if chunks_count is not None:
            doc["chunks_count"] = chunks_count
        self._save_state()

    def process_pdf(self, file_path: Path, filename: str, file_size: int, file_bytes: bytes) -> Dict[str, Any]:
        file_hash = hashlib.sha256(file_bytes).hexdigest()
        for existing in self._state["documents"].values():
            if existing.get("sha256") == file_hash and existing.get("status") == "Indexed Successfully":
                raise ValueError(
                    f'Duplicate document detected: "{filename}" matches already indexed "{existing["filename"]}".'
                )

        document_id = str(uuid.uuid4())
        doc_record: Dict[str, Any] = {
            "id": document_id,
            "filename": filename,
            "size_bytes": file_size,
            "pages": 0,
            "chunks_count": 0,
            "status": "Uploaded",
            "progress": 10,
            "error_message": None,
            "sha256": file_hash,
            "uploaded_at": _utc_now_iso(),
        }
        self._state["documents"][document_id] = doc_record
        self._state.setdefault("file_paths", {})[document_id] = file_path.name
        self._save_state()

        try:
            self.update_document_status(document_id, "Extracting Text", 25)
            reader = PdfReader(str(file_path))
            total_pages = len(reader.pages)
            if total_pages == 0:
                raise ValueError("The PDF contains zero pages.")

            extracted_pages: List[Tuple[int, str]] = []
            for idx, page in enumerate(reader.pages, start=1):
                raw_text = page.extract_text() or ""
                cleaned = re.sub(r"\s+", " ", raw_text).strip()
                if cleaned:
                    extracted_pages.append((idx, cleaned))

            if not extracted_pages:
                raise ValueError(
                    "No extractable text found. Scanned image-only or empty PDFs are not supported without OCR."
                )

            self.update_document_status(document_id, "Chunking", 50, pages=total_pages)
            all_chunks: List[Dict[str, Any]] = []
            for page_num, page_text in extracted_pages:
                all_chunks.extend(chunk_page_text(page_text, page_num, document_id, filename))

            if not all_chunks:
                raise ValueError("Unable to produce valid text chunks from the PDF.")

            self.update_document_status(document_id, "Generating Embeddings", 75)
            texts = [c["text"] for c in all_chunks]
            embeddings = self.embedder.encode(texts, normalize_embeddings=True).tolist()

            self.update_document_status(document_id, "Indexing in ChromaDB", 90)
            self.collection.add(
                ids=[c["chunk_id"] for c in all_chunks],
                embeddings=embeddings,
                documents=texts,
                metadatas=[
                    {
                        "document_id": c["document_id"],
                        "filename": c["filename"],
                        "page_number": c["page_number"],
                        "token_count": c["token_count"],
                    }
                    for c in all_chunks
                ],
            )

            self.update_document_status(
                document_id,
                "Indexed Successfully",
                100,
                pages=total_pages,
                chunks_count=len(all_chunks),
            )
            return self._state["documents"][document_id]
        except Exception as exc:
            self.update_document_status(
                document_id,
                "Failed",
                0,
                error_message=str(exc),
            )
            raise

    def delete_document(self, document_id: str) -> bool:
        doc = self._state["documents"].get(document_id)
        if not doc:
            return False
        try:
            self.collection.delete(where={"document_id": document_id})
        except Exception:
            pass
        file_paths = self._state.setdefault("file_paths", {})
        disk_name = file_paths.pop(document_id, None)
        if disk_name:
            upload_root = UPLOAD_DIR.resolve()
            disk_path = (upload_root / disk_name).resolve()
            if disk_path.is_relative_to(upload_root):
                disk_path.unlink(missing_ok=True)
        del self._state["documents"][document_id]
        self._save_state()
        return True

    def retrieve_chunks(
        self,
        question: str,
        top_k: int = 5,
        document_ids: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        indexed_docs = [
            d for d in self._state["documents"].values() if d.get("status") == "Indexed Successfully"
        ]
        if not indexed_docs:
            return []

        if document_ids is not None and len(document_ids) == 0:
            return []

        allowed_docs = (
            [d for d in indexed_docs if d["id"] in set(document_ids)]
            if document_ids
            else indexed_docs
        )
        available_chunks = sum(int(d.get("chunks_count", 0)) for d in allowed_docs)
        if available_chunks == 0:
            return []

        query_embedding = self.embedder.encode([question], normalize_embeddings=True).tolist()
        where_filter: Optional[Dict[str, Any]] = None
        if document_ids:
            if len(document_ids) == 1:
                where_filter = {"document_id": document_ids[0]}
            else:
                where_filter = {"document_id": {"$in": document_ids}}

        total_indexed = self.collection.count()
        if total_indexed == 0:
            return []

        results = self.collection.query(
            query_embeddings=query_embedding,
            n_results=min(top_k, available_chunks, total_indexed),
            where=where_filter,
            include=["documents", "metadatas", "distances"],
        )

        ids = (results.get("ids") or [[]])[0]
        docs = (results.get("documents") or [[]])[0]
        metas = (results.get("metadatas") or [[]])[0]
        dists = (results.get("distances") or [[]])[0]

        sources: List[Dict[str, Any]] = []
        for rank, (chunk_id, text, meta, dist) in enumerate(zip(ids, docs, metas, dists), start=1):
            similarity = max(0.0, min(1.0, 1.0 - float(dist)))
            sources.append(
                {
                    "rank": rank,
                    "chunk_id": chunk_id,
                    "document_id": meta.get("document_id", ""),
                    "filename": meta.get("filename", "Unknown.pdf"),
                    "page_number": int(meta.get("page_number", 1)),
                    "text": text,
                    "distance": round(float(dist), 4),
                    "similarity": round(similarity, 4),
                }
            )
        return sources

    def record_question(self, question: str, answer: str, sources: List[Dict[str, Any]]) -> None:
        self._state["questions_answered"] = int(self._state.get("questions_answered", 0)) + 1
        self._state["conversations"].insert(
            0,
            {
                "id": str(uuid.uuid4()),
                "question": question,
                "answer": answer,
                "sources": sources,
                "created_at": _utc_now_iso(),
            },
        )
        self._state["conversations"] = self._state["conversations"][:50]
        self._save_state()

    def get_history(self) -> List[Dict[str, Any]]:
        return self._state.get("conversations", [])

    def clear_history(self) -> None:
        self._state["conversations"] = []
        self._save_state()

    def get_dashboard_stats(self) -> Dict[str, Any]:
        docs = self.list_documents()
        indexed_docs = [d for d in docs if d.get("status") == "Indexed Successfully"]
        return {
            "total_documents": len(docs),
            "indexed_documents": len(indexed_docs),
            "total_pages_processed": sum(int(d.get("pages", 0)) for d in indexed_docs),
            "total_chunks_indexed": sum(int(d.get("chunks_count", 0)) for d in indexed_docs),
            "questions_answered": int(self._state.get("questions_answered", 0)),
            "recent_documents": docs[:8],
            "recent_conversations": self._state.get("conversations", [])[:5],
        }


pipeline = RagPipeline()
