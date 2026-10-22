# Third-party notices

NAI 자동저장's own code is under the MIT License (see `LICENSE`). These parts
come from others and keep their own licenses.

## Included in the extension

| Part | Where | License |
|---|---|---|
| ONNX Runtime Web 1.30.0 (Microsoft) | `vendor/ort/` | MIT — `vendor/ort/LICENSE` |
| Pretendard (Kil Hyung-jin) | `fonts/PretendardVariable.woff2` | SIL Open Font License 1.1 — `fonts/Pretendard-LICENSE.txt` |
| Material Symbols Rounded icon outlines (Google) | icon paths inside `content.js` | Apache License 2.0 — `licenses/Apache-2.0.txt` |

## Downloaded only when the user asks for it (not included)

| Part | When | Notes |
|---|---|---|
| Censor detection model `censor_detect_v1.0_s` from Hugging Face `deepghs/anime_censor_detection` | The first time 검열 사본 is used, after the user agrees | The model card states MIT. The model was trained with Ultralytics YOLOv8; this extension contains no Ultralytics code and runs the model with ONNX Runtime. |
| Chrome's built-in translation model | When tag translation is first used | Provided by Chrome. |

## Not included

NovelAI, Notion and Hugging Face are trademarks of their owners. This is an
unofficial tool and is not affiliated with them. The Korean tag meanings in
`data/tags-ko.json` were written for this project.
