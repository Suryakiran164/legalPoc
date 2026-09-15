"""
OCR microservice for the Legal Metrology Compliance PoC.

Why a separate Python service: EasyOCR/PaddleOCR are Python libraries with
heavy native/ML dependencies (PyTorch etc). Rather than shelling out from
Node, we run a small Flask service and call it over HTTP from the Express
backend. This keeps the two runtimes cleanly separated and lets you swap
OCR engines (EasyOCR <-> PaddleOCR) without touching the Node backend.

Run:
    pip install -r requirements.txt
    python app.py
Listens on port 8001 by default (override with OCR_SERVICE_PORT).
"""
import io
import os

from flask import Flask, request, jsonify
from flask_cors import CORS
from PIL import Image
import numpy as np

app = Flask(__name__)
CORS(app)

# Lazy-load the OCR reader so `python app.py --help`-style invocations and
# import-time errors don't require the (large) model download immediately.
_reader = None


def get_reader():
    global _reader
    if _reader is None:
        import easyocr
        # English only for the PoC; add more language codes as needed,
        # e.g. easyocr.Reader(['en', 'hi']) for Hindi labels.
        # Disable EasyOCR's Unicode progress output because the service may
        # run under a Windows cp1252 console, which cannot encode its bar.
        _reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    return _reader


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "service": "ocr-service"})


@app.route('/ocr', methods=['POST'])
def ocr():
    if 'image' not in request.files:
        return jsonify({"error": "No image file provided (field name: 'image')."}), 400

    file = request.files['image']
    try:
        image = Image.open(io.BytesIO(file.read())).convert('RGB')
    except Exception as exc:
        return jsonify({"error": f"Could not read image: {exc}"}), 400

    reader = get_reader()
    np_image = np.array(image)

    # detail=1 returns (bbox, text, confidence) tuples
    raw_results = reader.readtext(np_image, detail=1, paragraph=False)

    blocks = []
    confidences = []
    text_lines = []
    for bbox, text, confidence in raw_results:
        blocks.append({
            "text": text,
            "confidence": float(confidence),
            "bbox": [[float(x), float(y)] for x, y in bbox],
        })
        confidences.append(float(confidence))
        text_lines.append(text)

    full_text = "\n".join(text_lines)
    avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

    return jsonify({
        "blocks": blocks,
        "full_text": full_text,
        "avg_confidence": avg_confidence,
    })


if __name__ == '__main__':
    port = int(os.environ.get('OCR_SERVICE_PORT', 8001))
    app.run(host='0.0.0.0', port=port, debug=False)
