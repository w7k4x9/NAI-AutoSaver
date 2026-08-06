(function bootstrapNaiAutoSaver(global) {
  "use strict";

  if (window.__naiAutoSaverLoaded) {
    return;
  }
  window.__naiAutoSaverLoaded = true;

  const Store = global.NAIQueueStore;
  if (!Store) {
    return;
  }

  const QUEUE_STORAGE_KEY = "naiAutoSaver.queue";
  const UI_STORAGE_KEY = "naiAutoSaver.ui";
  const GENERATOR_STORAGE_KEY = "naiAutoSaver.generator";
  const MEMO_STORAGE_KEY = "naiAutoSaver.promptMemos";
  const AUTO_REFRESH_MS = 500;
  // NovelAI generations are at least 512px on the short side. Low-res preview
  // placeholders that flash in during the image swap are much smaller in their
  // *natural* size, so a floor here rejects them and prevents blank saves.
  const MIN_IMAGE_DIM = 256;
  const HOST_ID = "nai-auto-saver-host";

  // NovelAI V4 splits each prompt area into "Prompt" and "Undesired Content"
  // tabs. The UC editor lives under this wrapper. Positive prompts must never be
  // written into it, and the negative prompt must only be written into it.
  const UC_SELECTOR = ".prompt-input-box-undesired-content";
  function isInUndesired(element) {
    return Boolean(element && element.closest && element.closest(UC_SELECTOR));
  }

  // NovelAI versions the character-prompt wrapper class with a 1-based suffix
  // (e.g. ".prompt-input-box-character-prompts-1", ".prompt-input-box-character-prompts-2").
  // Older builds used the unsuffixed singular ".prompt-input-box-character-prompt".
  // Match BOTH with a substring selector so a NovelAI rename can't silently break
  // character detection (which previously caused character-negative to be dropped
  // and the base prompt to swallow the character-negative box).
  const CHAR_WRAPPER_SELECTOR = '[class*="prompt-input-box-character-prompt"]';
  // Base prompt wrapper. Accept the known stable names plus any versioned
  // "...base-prompt" variant defensively, mirroring the character fix above.
  const BASE_WRAPPER_SELECTOR =
    '.prompt-input-box-base-prompt, .prompt-input-box-prompt, [class*="prompt-input-box-base-prompt"]';

  // Downloads can only go to a SUBFOLDER under the browser's Downloads dir, never
  // an absolute path. If the user pastes "C:\...\NovelAI", keep just the final
  // folder name so we don't create an ugly "C_/Users/.../NovelAI" tree.
  function normalizeFolderInput(value) {
    let v = String(value == null ? "" : value).trim().replace(/\\/g, "/");
    const looksAbsolute = /^[a-zA-Z]:/.test(v) || v.startsWith("/") || v.startsWith("//");
    if (looksAbsolute) {
      const segs = v.split("/").map((s) => s.trim()).filter(Boolean);
      v = segs.length ? segs[segs.length - 1] : "NovelAI";
    }
    return v;
  }

  // Google Material Symbols Rounded (FILL=1, wght=400, opsz=24). Font coords (y-up), flipped in icon().
  const ICON_PATHS = {
    play_arrow: "M320 273V687Q320 704 332.0 715.5Q344 727 360 727Q365 727 370.5 725.5Q376 724 381 721L707 514Q716 508 720.5 499.0Q725 490 725.0 480.0Q725 470 720.5 461.0Q716 452 707 446L381 239Q376 236 370.5 234.5Q365 233 360 233Q344 233 332.0 244.5Q320 256 320 273ZM400 614 610 480 400 346ZM400 346 610 480 400 614Z",
    pause: "M640 200Q607 200 583.5 223.5Q560 247 560 280V680Q560 713 583.5 736.5Q607 760 640 760Q673 760 696.5 736.5Q720 713 720 680V280Q720 247 696.5 223.5Q673 200 640 200ZM320 200Q287 200 263.5 223.5Q240 247 240 280V680Q240 713 263.5 736.5Q287 760 320 760Q353 760 376.5 736.5Q400 713 400 680V280Q400 247 376.5 223.5Q353 200 320 200ZM640 280V680ZM320 280V680ZM320 680V280ZM640 680V280Z",
    stop: "M240 320V640Q240 673 263.5 696.5Q287 720 320 720H640Q673 720 696.5 696.5Q720 673 720 640V320Q720 287 696.5 263.5Q673 240 640 240H320Q287 240 263.5 263.5Q240 287 240 320ZM320 320H640Q640 320 640.0 320.0Q640 320 640 320V640Q640 640 640.0 640.0Q640 640 640 640H320Q320 640 320.0 640.0Q320 640 320 640V320Q320 320 320.0 320.0Q320 320 320 320ZM320 320Q320 320 320.0 320.0Q320 320 320 320V640Q320 640 320.0 640.0Q320 640 320 640H640Q640 640 640.0 640.0Q640 640 640 640V320Q640 320 640.0 320.0Q640 320 640 320Z",
    lists: "M400 160Q367 160 343.5 183.5Q320 207 320.0 240.0Q320 273 343.5 296.5Q367 320 400 320H800Q833 320 856.5 296.5Q880 273 880.0 240.0Q880 207 856.5 183.5Q833 160 800 160ZM400 400Q367 400 343.5 423.5Q320 447 320.0 480.0Q320 513 343.5 536.5Q367 560 400 560H800Q833 560 856.5 536.5Q880 513 880.0 480.0Q880 447 856.5 423.5Q833 400 800 400ZM400 640Q367 640 343.5 663.5Q320 687 320.0 720.0Q320 753 343.5 776.5Q367 800 400 800H800Q833 800 856.5 776.5Q880 753 880.0 720.0Q880 687 856.5 663.5Q833 640 800 640ZM160.0 640.0Q127 640 103.5 663.5Q80 687 80.0 720.0Q80 753 103.5 776.5Q127 800 160.0 800.0Q193 800 216.5 776.5Q240 753 240.0 720.0Q240 687 216.5 663.5Q193 640 160.0 640.0ZM160 400Q127 400 103.5 423.5Q80 447 80.0 480.0Q80 513 103.5 536.5Q127 560 160 560Q193 560 216.5 536.5Q240 513 240.0 480.0Q240 447 216.5 423.5Q193 400 160 400ZM160 160Q127 160 103.5 183.5Q80 207 80.0 240.0Q80 273 103.5 296.5Q127 320 160 320Q193 320 216.5 296.5Q240 273 240.0 240.0Q240 207 216.5 183.5Q193 160 160 160Z",
    settings: "M433 80Q406 80 386.5 98.0Q367 116 363 142L354 208Q341 213 329.5 220.0Q318 227 307 235L245 209Q220 198 195.0 207.0Q170 216 156 239L109 321Q95 344 101.0 370.0Q107 396 128 413L181 453Q180 460 180.0 466.5Q180 473 180 480Q180 487 180.0 493.5Q180 500 181 507L128 547Q107 564 101.0 590.0Q95 616 109 639L156 721Q170 744 195.0 753.0Q220 762 245 751L307 725Q318 733 330.0 740.0Q342 747 354 752L363 818Q367 844 386.5 862.0Q406 880 433 880H527Q554 880 573.5 862.0Q593 844 597 818L606 752Q619 747 630.5 740.0Q642 733 653 725L715 751Q740 762 765.0 753.0Q790 744 804 721L851 639Q865 616 859.0 590.0Q853 564 832 547L779 507Q780 500 780.0 493.5Q780 487 780 480Q780 473 780.0 466.5Q780 460 778 453L831 413Q852 396 858.0 370.0Q864 344 850 321L802 239Q788 216 763.0 207.0Q738 198 713 209L653 235Q642 227 630.0 220.0Q618 213 606 208L597 142Q593 116 573.5 98.0Q554 80 527 80ZM440 160H519L533 266Q564 274 590.5 289.5Q617 305 639 327L738 286L777 354L691 419Q696 433 698.0 448.5Q700 464 700 480Q700 496 698.0 511.5Q696 527 691 541L777 606L738 674L639 632Q617 655 590.5 670.5Q564 686 533 694L520 800H441L427 694Q396 686 369.5 670.5Q343 655 321 633L222 674L183 606L269 542Q264 527 262.0 512.0Q260 497 260 480Q260 464 262.0 449.0Q264 434 269 419L183 354L222 286L321 328Q343 305 369.5 289.5Q396 274 427 266ZM482 340Q540 340 581.0 381.0Q622 422 622.0 480.0Q622 538 581.0 579.0Q540 620 482 620Q423 620 382.5 579.0Q342 538 342.0 480.0Q342 422 382.5 381.0Q423 340 482 340ZM440 160 427 266Q396 274 369.5 289.5Q343 305 321 328L222 286L183 354L269 419Q264 434 262.0 449.0Q260 464 260 480Q260 497 262.0 512.0Q264 527 269 542L183 606L222 674L321 633Q343 655 369.5 670.5Q396 686 427 694L441 800H520L533 694Q564 686 590.5 670.5Q617 655 639 632L738 674L777 606L691 541Q696 527 698.0 511.5Q700 496 700 480Q700 464 698.0 448.5Q696 433 691 419L777 354L738 286L639 327Q617 305 590.5 289.5Q564 274 533 266L519 160Z",
    add: "M440 440H240Q223 440 211.5 451.5Q200 463 200.0 480.0Q200 497 211.5 508.5Q223 520 240 520H440V720Q440 737 451.5 748.5Q463 760 480.0 760.0Q497 760 508.5 748.5Q520 737 520 720V520H720Q737 520 748.5 508.5Q760 497 760.0 480.0Q760 463 748.5 451.5Q737 440 720 440H520V240Q520 223 508.5 211.5Q497 200 480.0 200.0Q463 200 451.5 211.5Q440 223 440 240Z",
    close: "M480 424 284 228Q273 217 256.0 217.0Q239 217 228 228Q217 239 217.0 256.0Q217 273 228 284L424 480L228 676Q217 687 217.0 704.0Q217 721 228 732Q239 743 256.0 743.0Q273 743 284 732L480 536L676 732Q687 743 704.0 743.0Q721 743 732 732Q743 721 743.0 704.0Q743 687 732 676L536 480L732 284Q743 273 743.0 256.0Q743 239 732 228Q721 217 704.0 217.0Q687 217 676 228Z",
    download: "M452 348 308 492Q296 504 296.5 520.0Q297 536 308 548Q320 560 336.5 560.5Q353 561 365 549L440 474V760Q440 777 451.5 788.5Q463 800 480.0 800.0Q497 800 508.5 788.5Q520 777 520 760V474L595 549Q607 561 623.5 560.5Q640 560 652 548Q663 536 663.5 520.0Q664 504 652 492L508 348Q502 342 495.0 339.5Q488 337 480.0 337.0Q472 337 465.0 339.5Q458 342 452 348ZM240 160Q207 160 183.5 183.5Q160 207 160 240V320Q160 337 171.5 348.5Q183 360 200.0 360.0Q217 360 228.5 348.5Q240 337 240 320V240Q240 240 240.0 240.0Q240 240 240 240H720Q720 240 720.0 240.0Q720 240 720 240V320Q720 337 731.5 348.5Q743 360 760.0 360.0Q777 360 788.5 348.5Q800 337 800 320V240Q800 207 776.5 183.5Q753 160 720 160Z",
    upload: "M240 160Q207 160 183.5 183.5Q160 207 160 240V320Q160 337 171.5 348.5Q183 360 200.0 360.0Q217 360 228.5 348.5Q240 337 240 320V240Q240 240 240.0 240.0Q240 240 240 240H720Q720 240 720.0 240.0Q720 240 720 240V320Q720 337 731.5 348.5Q743 360 760.0 360.0Q777 360 788.5 348.5Q800 337 800 320V240Q800 207 776.5 183.5Q753 160 720 160ZM440 646 365 571Q353 559 336.5 559.5Q320 560 308 572Q297 584 296.5 600.0Q296 616 308 628L452 772Q458 778 465.0 780.5Q472 783 480.0 783.0Q488 783 495.0 780.5Q502 778 508 772L652 628Q664 616 663.5 600.0Q663 584 652 572Q640 560 623.5 559.5Q607 559 595 571L520 646V360Q520 343 508.5 331.5Q497 320 480.0 320.0Q463 320 451.5 331.5Q440 343 440 360Z",
    delete: "M280 120Q247 120 223.5 143.5Q200 167 200 200V720Q183 720 171.5 731.5Q160 743 160.0 760.0Q160 777 171.5 788.5Q183 800 200 800H360Q360 817 371.5 828.5Q383 840 400 840H560Q577 840 588.5 828.5Q600 817 600 800H760Q777 800 788.5 788.5Q800 777 800.0 760.0Q800 743 788.5 731.5Q777 720 760 720V200Q760 167 736.5 143.5Q713 120 680 120ZM680 720H280V200Q280 200 280.0 200.0Q280 200 280 200H680Q680 200 680.0 200.0Q680 200 680 200ZM440 320V600Q440 617 428.5 628.5Q417 640 400.0 640.0Q383 640 371.5 628.5Q360 617 360 600V320Q360 303 371.5 291.5Q383 280 400.0 280.0Q417 280 428.5 291.5Q440 303 440 320ZM600 320V600Q600 617 588.5 628.5Q577 640 560.0 640.0Q543 640 531.5 628.5Q520 617 520 600V320Q520 303 531.5 291.5Q543 280 560.0 280.0Q577 280 588.5 291.5Q600 303 600 320ZM280 720H680V200Q680 200 680.0 200.0Q680 200 680 200H280Q280 200 280.0 200.0Q280 200 280 200Z",
    keyboard_arrow_up: "M480 528 324 372Q313 361 296.0 361.0Q279 361 268.0 372.0Q257 383 257.0 400.0Q257 417 268 428L452 612Q464 624 480.0 624.0Q496 624 508 612L692 428Q703 417 703.0 400.0Q703 383 692.0 372.0Q681 361 664.0 361.0Q647 361 636 372Z",
    keyboard_arrow_down: "M452 372 268 556Q257 567 257.0 584.0Q257 601 268.0 612.0Q279 623 296.0 623.0Q313 623 324 612L480 456L636 612Q647 623 664.0 623.0Q681 623 692.0 612.0Q703 601 703.0 584.0Q703 567 692 556L508 372Q502 366 495.0 363.5Q488 361 480.0 361.0Q472 361 465.0 363.5Q458 366 452 372Z",
    image: "M200 120Q167 120 143.5 143.5Q120 167 120 200V760Q120 793 143.5 816.5Q167 840 200 840H760Q793 840 816.5 816.5Q840 793 840 760V200Q840 167 816.5 143.5Q793 120 760 120ZM200 200H760Q760 200 760.0 200.0Q760 200 760 200V760Q760 760 760.0 760.0Q760 760 760 760H200Q200 760 200.0 760.0Q200 760 200 760V200Q200 200 200.0 200.0Q200 200 200 200ZM200 200Q200 200 200.0 200.0Q200 200 200 200V760Q200 760 200.0 760.0Q200 760 200 760H760Q760 760 760.0 760.0Q760 760 760 760V200Q760 200 760.0 200.0Q760 200 760 200ZM280 280H680Q692 280 698.0 291.0Q704 302 696 312L586 459Q580 467 570.0 467.0Q560 467 554 459L450 320L376 419Q370 427 360.0 427.0Q350 427 344 419L264 312Q256 302 262.0 291.0Q268 280 280 280Z",
    auto_awesome: "M706 706 636 738Q630 741 627.5 746.0Q625 751 625.0 756.0Q625 761 627.5 766.0Q630 771 636 774L706 806L738 876Q741 882 746.0 885.0Q751 888 756.0 888.0Q761 888 766.0 885.0Q771 882 774 876L806 806L876 774Q882 771 885.0 766.0Q888 761 888.0 756.0Q888 751 885.0 746.0Q882 741 876 738L806 706L774 636Q771 630 766.0 627.5Q761 625 756.0 625.0Q751 625 746.0 627.5Q741 630 738 636ZM260 380 100 453Q91 457 87.0 464.5Q83 472 83.0 480.0Q83 488 87.0 495.5Q91 503 100 507L260 580L333 740Q337 749 344.5 753.0Q352 757 360.0 757.0Q368 757 375.5 753.0Q383 749 387 740L460 580L620 507Q629 503 633.0 495.5Q637 488 637.0 480.0Q637 472 633.0 464.5Q629 457 620 453L460 380L387 220Q383 211 375.5 207.0Q368 203 360.0 203.0Q352 203 344.5 207.0Q337 211 333 220ZM360 354 400 440 486 480 400 520 360 606 320 520 234 480 320 440ZM710 150 640 182Q634 185 631.0 190.0Q628 195 628.0 200.0Q628 205 631.0 210.0Q634 215 640 218L710 250L742 320Q745 326 750.0 329.0Q755 332 760.0 332.0Q765 332 770.0 329.0Q775 326 778 320L810 250L880 218Q886 215 889.0 210.0Q892 205 892.0 200.0Q892 195 889.0 190.0Q886 185 880 182L810 150L778 80Q775 74 770.0 71.0Q765 68 760.0 68.0Q755 68 750.0 71.0Q745 74 742 80ZM360 354 320 440 234 480 320 520 360 606 400 520 486 480 400 440Z",
    playlist_add: "M160 320Q143 320 131.5 331.5Q120 343 120.0 360.0Q120 377 131.5 388.5Q143 400 160 400H360Q377 400 388.5 388.5Q400 377 400.0 360.0Q400 343 388.5 331.5Q377 320 360 320ZM160 480Q143 480 131.5 491.5Q120 503 120.0 520.0Q120 537 131.5 548.5Q143 560 160 560H520Q537 560 548.5 548.5Q560 537 560.0 520.0Q560 503 548.5 491.5Q537 480 520 480ZM160 640Q143 640 131.5 651.5Q120 663 120.0 680.0Q120 697 131.5 708.5Q143 720 160 720H520Q537 720 548.5 708.5Q560 697 560.0 680.0Q560 663 548.5 651.5Q537 640 520 640ZM640 200V320H520Q503 320 491.5 331.5Q480 343 480.0 360.0Q480 377 491.5 388.5Q503 400 520 400H640V520Q640 537 651.5 548.5Q663 560 680.0 560.0Q697 560 708.5 548.5Q720 537 720 520V400H840Q857 400 868.5 388.5Q880 377 880.0 360.0Q880 343 868.5 331.5Q857 320 840 320H720V200Q720 183 708.5 171.5Q697 160 680.0 160.0Q663 160 651.5 171.5Q640 183 640 200Z",
    bolt: "M422 232 629 480H469L498 707L313 440H452ZM360 360H236Q212 360 200.5 381.5Q189 403 203 423L502 853Q512 867 528.0 872.5Q544 878 561.0 872.0Q578 866 586.0 851.0Q594 836 592 819L560 560H715Q741 560 751.5 537.0Q762 514 745 494L416 100Q405 87 389.0 83.0Q373 79 358.0 86.0Q343 93 334.5 107.5Q326 122 328 139ZM422 232 452 440H313L498 707L469 480H629Z",
    tune: "M440 160V320Q440 337 451.5 348.5Q463 360 480.0 360.0Q497 360 508.5 348.5Q520 337 520 320V280H800Q817 280 828.5 268.5Q840 257 840.0 240.0Q840 223 828.5 211.5Q817 200 800 200H520V160Q520 143 508.5 131.5Q497 120 480.0 120.0Q463 120 451.5 131.5Q440 143 440 160ZM160 200Q143 200 131.5 211.5Q120 223 120.0 240.0Q120 257 131.5 268.5Q143 280 160 280H320Q337 280 348.5 268.5Q360 257 360.0 240.0Q360 223 348.5 211.5Q337 200 320 200ZM280 400V440H160Q143 440 131.5 451.5Q120 463 120.0 480.0Q120 497 131.5 508.5Q143 520 160 520H280V560Q280 577 291.5 588.5Q303 600 320.0 600.0Q337 600 348.5 588.5Q360 577 360 560V400Q360 383 348.5 371.5Q337 360 320.0 360.0Q303 360 291.5 371.5Q280 383 280 400ZM480 440Q463 440 451.5 451.5Q440 463 440.0 480.0Q440 497 451.5 508.5Q463 520 480 520H800Q817 520 828.5 508.5Q840 497 840.0 480.0Q840 463 828.5 451.5Q817 440 800 440ZM600 640V800Q600 817 611.5 828.5Q623 840 640.0 840.0Q657 840 668.5 828.5Q680 817 680 800V760H800Q817 760 828.5 748.5Q840 737 840.0 720.0Q840 703 828.5 691.5Q817 680 800 680H680V640Q680 623 668.5 611.5Q657 600 640.0 600.0Q623 600 611.5 611.5Q600 623 600 640ZM160 680Q143 680 131.5 691.5Q120 703 120.0 720.0Q120 737 131.5 748.5Q143 760 160 760H480Q497 760 508.5 748.5Q520 737 520.0 720.0Q520 703 508.5 691.5Q497 680 480 680Z",
    movie: "M160 800 225 670Q232 656 245.0 648.0Q258 640 273 640Q303 640 319.0 665.5Q335 691 321 718L280 800H360L425 670Q432 656 445.0 648.0Q458 640 473 640Q503 640 519.0 665.5Q535 691 521 718L480 800H560L625 670Q632 656 645.0 648.0Q658 640 673 640Q703 640 719.0 665.5Q735 691 721 718L680 800H800Q833 800 856.5 776.5Q880 753 880 720V240Q880 207 856.5 183.5Q833 160 800 160H160Q127 160 103.5 183.5Q80 207 80 240V720Q80 753 103.5 776.5Q127 800 160 800ZM160 560V240Q160 240 160.0 240.0Q160 240 160 240H800Q800 240 800.0 240.0Q800 240 800 240V560ZM160 560H800V240Q800 240 800.0 240.0Q800 240 800 240H160Q160 240 160.0 240.0Q160 240 160 240Z",
    content_copy: "M360 240Q327 240 303.5 263.5Q280 287 280 320V800Q280 833 303.5 856.5Q327 880 360 880H720Q753 880 776.5 856.5Q800 833 800 800V320Q800 287 776.5 263.5Q753 240 720 240ZM360 320H720Q720 320 720.0 320.0Q720 320 720 320V800Q720 800 720.0 800.0Q720 800 720 800H360Q360 800 360.0 800.0Q360 800 360 800V320Q360 320 360.0 320.0Q360 320 360 320ZM200 80Q167 80 143.5 103.5Q120 127 120 160V680Q120 697 131.5 708.5Q143 720 160.0 720.0Q177 720 188.5 708.5Q200 697 200 680V160Q200 160 200.0 160.0Q200 160 200 160H600Q617 160 628.5 148.5Q640 137 640 120Q640 103 628.5 91.5Q617 80 600 80ZM360 320Q360 320 360.0 320.0Q360 320 360 320V800Q360 800 360.0 800.0Q360 800 360 800H720Q720 800 720.0 800.0Q720 800 720 800V320Q720 320 720.0 320.0Q720 320 720 320Z",
    fullscreen: "M200 200H280Q297 200 308.5 188.5Q320 177 320.0 160.0Q320 143 308.5 131.5Q297 120 280 120H160Q143 120 131.5 131.5Q120 143 120 160V280Q120 297 131.5 308.5Q143 320 160.0 320.0Q177 320 188.5 308.5Q200 297 200 280ZM760 200V280Q760 297 771.5 308.5Q783 320 800.0 320.0Q817 320 828.5 308.5Q840 297 840 280V160Q840 143 828.5 131.5Q817 120 800 120H680Q663 120 651.5 131.5Q640 143 640.0 160.0Q640 177 651.5 188.5Q663 200 680 200ZM200 760V680Q200 663 188.5 651.5Q177 640 160.0 640.0Q143 640 131.5 651.5Q120 663 120 680V800Q120 817 131.5 828.5Q143 840 160 840H280Q297 840 308.5 828.5Q320 817 320.0 800.0Q320 783 308.5 771.5Q297 760 280 760ZM760 760H680Q663 760 651.5 771.5Q640 783 640.0 800.0Q640 817 651.5 828.5Q663 840 680 840H800Q817 840 828.5 828.5Q840 817 840 800V680Q840 663 828.5 651.5Q817 640 800.0 640.0Q783 640 771.5 651.5Q760 663 760 680Z",
    fullscreen_exit: "M240 240H160Q143 240 131.5 251.5Q120 263 120.0 280.0Q120 297 131.5 308.5Q143 320 160 320H280Q297 320 308.5 308.5Q320 297 320 280V160Q320 143 308.5 131.5Q297 120 280.0 120.0Q263 120 251.5 131.5Q240 143 240 160ZM720 240V160Q720 143 708.5 131.5Q697 120 680.0 120.0Q663 120 651.5 131.5Q640 143 640 160V280Q640 297 651.5 308.5Q663 320 680 320H800Q817 320 828.5 308.5Q840 297 840.0 280.0Q840 263 828.5 251.5Q817 240 800 240ZM240 720V800Q240 817 251.5 828.5Q263 840 280.0 840.0Q297 840 308.5 828.5Q320 817 320 800V680Q320 663 308.5 651.5Q297 640 280 640H160Q143 640 131.5 651.5Q120 663 120.0 680.0Q120 697 131.5 708.5Q143 720 160 720ZM720 720H800Q817 720 828.5 708.5Q840 697 840.0 680.0Q840 663 828.5 651.5Q817 640 800 640H680Q663 640 651.5 651.5Q640 663 640 680V800Q640 817 651.5 828.5Q663 840 680.0 840.0Q697 840 708.5 828.5Q720 817 720 800Z",
    label: "M160 160Q127 160 103.5 183.5Q80 207 80 240V720Q80 753 103.5 776.5Q127 800 160 800H600Q619 800 636.0 791.5Q653 783 664 768L844 528Q860 507 860.0 480.0Q860 453 844 432L664 192Q653 177 636.0 168.5Q619 160 600 160ZM160 240H600Q600 240 600.0 240.0Q600 240 600 240L780 480Q780 480 780.0 480.0Q780 480 780 480L600 720Q600 720 600.0 720.0Q600 720 600 720H160Q160 720 160.0 720.0Q160 720 160 720V240Q160 240 160.0 240.0Q160 240 160 240ZM160 240Q160 240 160.0 240.0Q160 240 160 240V720Q160 720 160.0 720.0Q160 720 160 720H600Q600 720 600.0 720.0Q600 720 600 720L780 480Q780 480 780.0 480.0Q780 480 780 480L600 240Q600 240 600.0 240.0Q600 240 600 240Z",
    drag_indicator: "M360 160Q327 160 303.5 183.5Q280 207 280 240Q280 273 303.5 296.5Q327 320 360 320Q393 320 416.5 296.5Q440 273 440 240Q440 207 416.5 183.5Q393 160 360 160ZM600 160Q567 160 543.5 183.5Q520 207 520 240Q520 273 543.5 296.5Q567 320 600 320Q633 320 656.5 296.5Q680 273 680 240Q680 207 656.5 183.5Q633 160 600 160ZM360 400Q327 400 303.5 423.5Q280 447 280 480Q280 513 303.5 536.5Q327 560 360 560Q393 560 416.5 536.5Q440 513 440 480Q440 447 416.5 423.5Q393 400 360 400ZM600 400Q567 400 543.5 423.5Q520 447 520 480Q520 513 543.5 536.5Q567 560 600 560Q633 560 656.5 536.5Q680 513 680 480Q680 447 656.5 423.5Q633 400 600 400ZM360 640Q327 640 303.5 663.5Q280 687 280 720Q280 753 303.5 776.5Q327 800 360 800Q393 800 416.5 776.5Q440 753 440 720Q440 687 416.5 663.5Q393 640 360 640ZM600 640Q567 640 543.5 663.5Q520 687 520 720Q520 753 543.5 776.5Q567 800 600 800Q633 800 656.5 776.5Q680 753 680 720Q680 687 656.5 663.5Q633 640 600 640Z",
  };

  function icon(name, size = 22) {
    const d = ICON_PATHS[name];
    if (!d) return "";
    // Glyph coords are font-space (y-up, 0..960). Flip Y into SVG space.
    return `<svg class="ias-ic" width="${size}" height="${size}" viewBox="0 0 960 960" aria-hidden="true" focusable="false"><g transform="translate(0,960) scale(1,-1)"><path d="${d}" fill="currentColor"/></g></svg>`;
  }

  const SYNC_KEYS = [
    "intervalTime",
    "gcount",
    "singleSaveName",
    "saveFolder",
    "autoBase",
    "autoBaseNeg",
    "autoChar",
    "autoCharNeg",
    "autoSaveEnabled",
    "autoCompletionNotificationEnabled",
    "volume",
  ];

  let panelHost = null;
  let panelShadow = null;
  let ui = {};
  let queueState = { schemaVersion: 3, items: [], options: { loop: false } };
  let selectedQueueId = null;
  let queueSaveTimer = null;
  let memoState = { schemaVersion: 1, items: [] };
  let selectedMemoId = null;
  let panelCollapsed = true;
  let activeTab = "auto";
  let editorExpanded = false;
  let panelFullscreen = false;
  let panelPosition = null;
  let panelSize = null;
  let statusTimer = null;

  // ETA: rolling per-image wall-clock samples (generation + interval).
  const ETA_SEED_KEY = "naiAutoSaver.avgImageMs";
  const etaTracker = {
    samples: [],
    lastCompleteTs: 0,
    maxSamples: 8,
  };
  // Average ms/image measured in a previous run; used for the pre-run estimate.
  let seedImageMs = null;

  let saveContext = { baseName: "", counter: 0, lastSavedSrc: "" };

  const autoRun = {
    active: false,
    count: 0,
    completedCount: 0,
    target: 0,
    timerId: null,
    timeoutId: null,
    waitingForCompletion: false,
    waitingForExistingGeneration: false,
    stopAfterCurrent: false,
    ignoreReadyUntil: 0,
    token: 0,
    onComplete: null,
  };

  const queueRun = {
    active: false,
    index: 0,
    items: [],
    loop: false,
    token: 0,
    advancing: false,
    totalGenerated: 0,
    resolveItem: null,
  };

  // ---------------------------------------------------------------------------
  // utils
  // ---------------------------------------------------------------------------
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function storageGet(area, keys) {
    return new Promise((resolve) => {
      chrome.storage[area].get(keys, (result) => {
        void chrome.runtime.lastError;
        resolve(result || {});
      });
    });
  }

  function storageSet(area, values) {
    return new Promise((resolve) => {
      chrome.storage[area].set(values, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  function escapeHTML(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function isVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 16 && rect.height > 16;
  }

  // Small icon controls in NovelAI can be only 14–16px internally.  The general
  // isVisible() threshold is intentionally stricter for editors, but it must not
  // reject a real Character-header trash button.  This helper only checks whether
  // the element is actually rendered and clickable.
  function isRenderedControl(element) {
    if (!(element instanceof Element) || !element.isConnected) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---------------------------------------------------------------------------
  // NovelAI DOM interaction
  // ---------------------------------------------------------------------------
  function findGenerateButton() {
    return Array.from(document.querySelectorAll("button"))
      .find((button) => /Generate\s+\d+\s+Image(s)?/i.test(button.textContent || "")) || null;
  }

  function normalizeButtonText(button) {
    return String(button?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function findButtonByText(root, matcher) {
    if (!root) {
      return null;
    }
    return Array.from(root.querySelectorAll("button"))
      .filter(isVisible)
      .find((button) => matcher(normalizeButtonText(button))) || null;
  }

  function findPromptEditors() {
    return Array.from(document.querySelectorAll("[contenteditable]"))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.isContentEditable)
      .filter(isVisible)
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter((element) => !isInUndesired(element))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width >= 140 && rect.height >= 24;
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.top - bRect.top || aRect.left - bRect.left;
      });
  }

  function getBasePromptEditor() {
    const root = Array.from(document.querySelectorAll(".image-gen-prompt-main")).filter(isVisible)[0] || null;
    if (root) {
      const editors = Array.from(root.querySelectorAll("[contenteditable]"))
        .filter((element) => element instanceof HTMLElement)
        .filter((element) => element.isContentEditable)
        .filter((element) => !isInUndesired(element))
        .filter(isVisible);
      for (const editor of editors) {
        const wrapper = editor.closest(BASE_WRAPPER_SELECTOR);
        if (wrapper && !editor.closest(CHAR_WRAPPER_SELECTOR)) {
          return editor;
        }
      }
    }
    // Fallback: topmost prompt editor that is NOT a character box, so the base
    // prompt can never accidentally read/write a character-negative box.
    return findPromptEditors().filter((el) => !el.closest(CHAR_WRAPPER_SELECTOR))[0] || null;
  }

  function plainTextToHTML(text) {
    return String(text).split(/\r?\n/).map((line) => {
      if (!line) {
        return '<p><br class="ProseMirror-trailingBreak"></p>';
      }
      return `<p>${escapeHTML(line)}</p>`;
    }).join("");
  }

  function htmlToPlainText(html) {
    const container = document.createElement("div");
    container.innerHTML = html || "";
    const lines = [];
    for (const child of Array.from(container.childNodes)) {
      lines.push(child.textContent || "");
    }
    return lines.join("\n").trim();
  }

  function setEditablePlainText(editor, value) {
    editor.focus();
    editor.innerHTML = plainTextToHTML(value);
    try {
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      }));
    } catch (error) {
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function readEditableText(editor) {
    if (!editor) {
      return "";
    }
    const inner = typeof editor.innerText === "string" ? editor.innerText : "";
    return (inner || htmlToPlainText(editor.innerHTML) || editor.textContent || "")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function promptTagParts(value) {
    return String(value == null ? "" : value)
      .split(/[,\n]+/u)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function canonicalPromptTag(value) {
    const tag = String(value == null ? "" : value).replace(/\s+/g, " ").trim().toLowerCase();
    // NovelAI normalises the gender seed selected from the Add Character menu:
    // `1girl` is rendered as `girl,` and `1boy` as `boy,`. Treat those forms as
    // equivalent so a successful write is not mistaken for a failure/retried.
    if (tag === "1girl" || tag === "girl") {
      return "girl";
    }
    if (tag === "1boy" || tag === "boy") {
      return "boy";
    }
    return tag;
  }

  function normalizedPromptTags(value) {
    return promptTagParts(value).map(canonicalPromptTag);
  }

  function selectEditableContents(editor) {
    editor.focus();
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function moveCaretToEditableEnd(editor) {
    editor.focus();
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function execInsertText(text) {
    try {
      return document.execCommand("insertText", false, String(text));
    } catch (error) {
      return false;
    }
  }

  async function typePromptTags(editor, value, { clear = true } = {}) {
    const text = String(value == null ? "" : value).trim();
    if (!editor) {
      return false;
    }

    editor.focus();
    if (clear) {
      selectEditableContents(editor);
      let deleted = false;
      try {
        deleted = document.execCommand("delete", false, null);
      } catch (error) {
        deleted = false;
      }
      if (!deleted && readEditableText(editor)) {
        // Only a last-resort DOM clear. The native delete above is preferred
        // because ProseMirror/React observes it as a real editing operation.
        editor.innerHTML = "";
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await delay(45);
    } else {
      moveCaretToEditableEnd(editor);
    }

    if (!text) {
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    // NovelAI's character editor tokenizes at commas. Inserting one large HTML
    // string lets the UI keep only its auto-added gender tag (e.g. 1boy). Enter
    // each tag and delimiter through the browser editing pipeline instead, with a
    // short pause after commas so the next token is not lost during rerendering.
    const tags = promptTagParts(text);
    for (let i = 0; i < tags.length; i += 1) {
      editor.focus();
      if (i > 0) {
        moveCaretToEditableEnd(editor);
        execInsertText(", ");
        await delay(75);
      }
      moveCaretToEditableEnd(editor);
      execInsertText(tags[i]);
      await delay(35);
    }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(110);
    return true;
  }

  async function appendCharacterPromptTags(editor, tags) {
    const parts = Array.isArray(tags) ? tags.filter(Boolean) : [];
    if (!editor || !parts.length) {
      return;
    }
    for (let i = 0; i < parts.length; i += 1) {
      editor.focus();
      moveCaretToEditableEnd(editor);
      const current = readEditableText(editor);
      // The gender option creates `girl,` / `boy,` with a trailing comma. Do not
      // add a second comma before the first custom tag.
      const separator = i === 0 && /,\s*$/u.test(current)
        ? " "
        : (current ? ", " : "");
      if (separator) {
        execInsertText(separator);
        await delay(80);
      }
      execInsertText(parts[i]);
      await delay(55);
    }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(130);
  }

  async function setCharacterPromptText(editor, value) {
    const parts = promptTagParts(value);
    const expected = parts.map(canonicalPromptTag);
    let actual = normalizedPromptTags(readEditableText(editor));

    // A freshly-created character already contains `girl,` or `boy,`. Preserve
    // that native token and append only the missing tags; clearing/replacing it
    // causes NovelAI's editor to keep the gender token but discard the tail.
    const isPrefix = actual.length > 0
      && actual.length <= expected.length
      && actual.every((tag, index) => tag === expected[index]);
    if (isPrefix && actual.length < expected.length) {
      await appendCharacterPromptTags(editor, parts.slice(actual.length));
    } else if (actual.join("|") !== expected.join("|")) {
      await typePromptTags(editor, value, { clear: true });
    }

    actual = normalizedPromptTags(readEditableText(editor));
    if (expected.length && actual.join("|") !== expected.join("|")) {
      // After a rerender, append a still-missing suffix instead of clearing the
      // whole character again. This is especially important for collapsed cards.
      const retryPrefix = actual.length > 0
        && actual.length <= expected.length
        && actual.every((tag, index) => tag === expected[index]);
      if (retryPrefix && actual.length < expected.length) {
        await delay(180);
        await appendCharacterPromptTags(editor, parts.slice(actual.length));
      } else {
        await delay(180);
        await typePromptTags(editor, value, { clear: true });
      }
      actual = normalizedPromptTags(readEditableText(editor));
    }

    return expected.join("|") === actual.join("|");
  }


  async function readCurrentNaiPrompt() {
    const scope = getBaseArea() || document.body;
    await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
    const editor = getBasePromptEditor();
    return editor ? htmlToPlainText(editor.innerHTML) : "";
  }

  async function readCurrentNaiNegativePrompt() {
    const scope = getBaseArea() || document.body;
    await revealTabInScope(scope, "uc", { excludeCharacterBoxes: true });
    const editor = getBaseNegativeEditor();
    const text = editor ? htmlToPlainText(editor.innerHTML) : "";
    await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
    return text;
  }

  async function readCurrentNaiCharacterNegative() {
    const containers = getCharacterContainers();
    if (!containers.length) {
      return "";
    }
    const parts = [];
    for (const container of containers) {
      await revealTabInScope(container, "uc");
      const editor = getCharacterBoxEditor(container);
      parts.push(editor ? htmlToPlainText(editor.innerHTML).trim() : "");
      await revealTabInScope(container, "prompt");
    }
    return parts.join(" ;; ").replace(/(\s*;;\s*)+$/, "").trim();
  }

  function getCharacterPromptEditors() {
    // Character Prompts are rendered as a sibling section below the base prompt
    // in the current NovelAI layout, not necessarily inside .image-gen-prompt-main.
    // Search the page rather than the base-prompt-only wrapper.
    const root = document;
    // Preferred: explicit character-prompt wrappers.
    let editors = Array.from(root.querySelectorAll(`${CHAR_WRAPPER_SELECTOR} [contenteditable]`))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.isContentEditable)
      .filter(isVisible)
      .filter((element) => !isInUndesired(element))
      .filter((element) => !element.closest(`#${HOST_ID}`));
    // Fallback: every visible prompt editor except the base prompt editor.
    if (!editors.length) {
      const base = getBasePromptEditor();
      editors = findPromptEditors().filter((element) => element !== base);
    }
    return editors.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top || aRect.left - bRect.left;
    });
  }

  function accessibleControlText(element) {
    if (!element) {
      return "";
    }
    return [
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("data-tooltip"),
      element.getAttribute?.("data-tip"),
      element.getAttribute?.("data-testid"),
    ]
      .filter(Boolean)
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function ownControlText(element) {
    if (!element) {
      return "";
    }
    return Array.from(element.childNodes || [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function findAddCharacterButton() {
    const root = Array.from(document.querySelectorAll(".image-gen-prompt-main")).filter(isVisible)[0] || document;
    const selector = 'button, [role="button"]';
    const matchByLabel = (scope) => Array.from(scope.querySelectorAll(selector))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isVisible)
      .find((element) => /add\s*character|character\s*add|캐릭터\s*추가/i.test(accessibleControlText(element))) || null;

    const direct = matchByLabel(root) || matchByLabel(document.body);
    if (direct) {
      return direct;
    }

    // Current NovelAI uses an icon-only + button beside the "Character Prompts"
    // heading. It may have no useful text/aria-label, so locate the heading first
    // and choose the nearest visible button in the same compact header row.
    const labels = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6,label,p,span,div"))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isVisible)
      .filter((element) => /^character\s*prompts?$/i.test(ownControlText(element)));

    for (const label of labels) {
      const labelRect = label.getBoundingClientRect();
      let scope = label.parentElement;
      for (let depth = 0; scope && scope !== document.body && depth < 5; depth += 1, scope = scope.parentElement) {
        const buttons = Array.from(scope.querySelectorAll(selector))
          .filter((element) => !element.closest(`#${HOST_ID}`))
          .filter(isVisible)
          .filter((element) => !/^(?:female|male|other|여성|남성|기타)$/i.test(accessibleControlText(element)));
        if (!buttons.length) {
          continue;
        }
        const nearby = buttons
          .map((button) => {
            const rect = button.getBoundingClientRect();
            const verticalDistance = Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2));
            const horizontalDistance = Math.abs(rect.left - labelRect.right);
            return { button, score: verticalDistance * 3 + horizontalDistance };
          })
          .sort((a, b) => a.score - b.score)[0];
        if (nearby && nearby.score < 500) {
          return nearby.button;
        }
      }
    }
    return null;
  }

  function inferCharacterGender(prompt) {
    const value = String(prompt == null ? "" : prompt).toLowerCase();
    const female = /(?:^|[^a-z0-9_])(?:1girl|[2-9]girls?|girls?|female|woman|women)(?=$|[^a-z0-9_])/i.test(value);
    const male = /(?:^|[^a-z0-9_])(?:1boy|[2-9]boys?|boys?|male|man|men)(?=$|[^a-z0-9_])/i.test(value);
    if (female && !male) {
      return "female";
    }
    if (male && !female) {
      return "male";
    }
    return "other";
  }

  function normalizeGenderOptionText(value) {
    return String(value == null ? "" : value)
      // The current menu labels are rendered as "♀ Female", "♂ Male",
      // and "⚧ Other". Strip glyphs/variation selectors before matching.
      .replace(/[♀♂⚧⚥⚲\u200B-\u200D\uFE0E\uFE0F]/gu, " ")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function findCharacterGenderOption(preferredGender) {
    const names = {
      female: new Set(["female", "여성"]),
      male: new Set(["male", "남성"]),
      other: new Set(["other", "기타"]),
    };
    const order = [preferredGender, "other", "female", "male"]
      .filter((value, index, list) => value && list.indexOf(value) === index);
    const raw = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], li, [tabindex]'))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isVisible)
      .filter((element) => element.getAttribute?.("aria-disabled") !== "true" && !element.disabled)
      .map((element) => ({
        element,
        label: normalizeGenderOptionText(accessibleControlText(element)),
      }));

    for (const gender of order) {
      const option = raw.find(({ label }) => {
        const tokens = label.split(/\s+/u).filter(Boolean);
        return tokens.length > 0 && tokens.every((token) => names[gender].has(token));
      });
      if (option) {
        return option.element;
      }
    }
    return null;
  }

  function characterCountForSurface(surface) {
    if (surface instanceof Element && surface.isConnected) {
      return getCharacterContainersInSurface(surface).length;
    }
    return getCharacterContainers().length;
  }

  async function waitForCharacterBoxIncrease(before, attempts = 12, surface = null) {
    for (let i = 0; i < attempts; i += 1) {
      await delay(120);
      if (characterCountForSurface(surface) > before) {
        return true;
      }
    }
    return false;
  }

  function clickControlLikeUser(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const clientX = Math.max(rect.left + 2, Math.min(rect.right - 2, rect.left + rect.width / 2));
    const clientY = Math.max(rect.top + 2, Math.min(rect.bottom - 2, rect.top + rect.height / 2));
    const eventInit = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: 1 };
    try {
      if (typeof PointerEvent === "function") {
        element.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent("mousedown", eventInit));
      element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
      if (typeof PointerEvent === "function") {
        element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0 }));
      return true;
    } catch (error) {
      try {
        element.click();
        return true;
      } catch (innerError) {
        return false;
      }
    }
  }

  async function clickAddCharacterBox(characterPrompt = "", surface = null) {
    void characterPrompt;
    const before = characterCountForSurface(surface);
    const button = findAddCharacterButton();
    if (!button || button.disabled || button.getAttribute?.("aria-disabled") === "true") {
      return false;
    }
    clickControlLikeUser(button);

    // Female / Male / Other only seeds the new Character card.  The queue writes
    // the full prompt immediately afterwards, so any visible option is valid and
    // there is no reason to reset every card merely to match an inferred gender.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await delay(80);
      const genderOption = findCharacterGenderOption("female")
        || findCharacterGenderOption("male")
        || findCharacterGenderOption("other");
      if (genderOption) {
        clickControlLikeUser(genderOption);
        return waitForCharacterBoxIncrease(before, 16, surface);
      }
      if (characterCountForSurface(surface) > before) {
        return true;
      }
    }
    return characterCountForSurface(surface) > before;
  }

  async function readCurrentNaiCharacterPrompt() {
    const containers = getCharacterContainers();
    if (!containers.length) {
      return "";
    }
    const parts = [];
    for (const container of containers) {
      await revealTabInScope(container, "prompt");
      const editor = getCharacterBoxEditor(container);
      const text = editor ? htmlToPlainText(editor.innerHTML).trim() : "";
      if (text) {
        parts.push(text);
      }
    }
    return parts.join(" ;; ");
  }

  async function applyPromptToNovelAi(text) {
    if (text == null || String(text).trim() === "") {
      return { ok: true, skipped: true };
    }
    const scope = getBaseArea() || document.body;
    await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
    const editor = getBasePromptEditor();
    if (!editor) {
      return { ok: false, error: "NovelAI 프롬프트 입력 영역을 찾지 못했습니다." };
    }
    setEditablePlainText(editor, text);
    await delay(180);
    return { ok: true };
  }

  // NovelAI V4 gives the base prompt AND each character their own "Prompt" /
  // "Undesired Content" tab pair. We must write negatives ONLY into a real UC
  // editor, never into a prompt editor. The prompt wrappers below are the
  // known-correct positive-prompt boxes, so "a visible editor that is NOT inside
  // one of these" is the UC editor — this avoids guessing the UC class name and
  // makes it impossible to contaminate a prompt box.
  const UC_TAB_RE = /undesired|네거티브|negative|^\s*uc\s*$/i;
  const PROMPT_TAB_RE = /^\s*prompt\s*$|프롬프트|base\s*prompt/i;
  const PROMPT_WRAPPER_SELECTOR =
    `${BASE_WRAPPER_SELECTOR}, ${CHAR_WRAPPER_SELECTOR}`;

  function isPromptEditor(element) {
    return Boolean(element && element.closest && element.closest(PROMPT_WRAPPER_SELECTOR));
  }

  function findTabButton(root, labelRegex, { excludeCharacterBoxes = false } = {}) {
    if (!root) {
      return null;
    }
    return Array.from(root.querySelectorAll("button"))
      .filter(isVisible)
      .filter((button) => !button.closest(`#${HOST_ID}`))
      .filter((button) => !excludeCharacterBoxes || !button.closest(CHAR_WRAPPER_SELECTOR))
      .find((button) => labelRegex.test(normalizeButtonText(button))) || null;
  }

  function getBaseArea() {
    return Array.from(document.querySelectorAll(".image-gen-prompt-main")).filter(isVisible)[0] || null;
  }

  // NovelAI may unmount/hide the prompt editor when a character card is
  // collapsed. Count cards by their `Character N` headers first, then fall back
  // to prompt wrappers. This keeps Add Character from creating duplicates just
  // because the newly-added card is collapsed.
  const CHARACTER_HEADER_RE = /^(?:♀|♂|⚧)?\s*character\s+(\d+)\s*$/i;

  function normalizeCharacterHeaderText(value) {
    return String(value == null ? "" : value)
      // Emoji-style gender glyphs can include variation selectors / joiners.
      .replace(/[\u200B-\u200D\uFE0E\uFE0F]/gu, "")
      .trim()
      .replace(/\s+/g, " ");
  }

  function getCharacterHeaderElements(root = document) {
    // The current NovelAI UI nests the visible `Character N` text inside one or
    // more spans. Looking only at an element's direct text nodes therefore misses
    // every card and makes the extension think no character boxes exist. Match an
    // element whose COMPLETE rendered text is exactly the header, then keep the
    // deepest matching element so parent wrappers are not counted twice.
    const candidates = Array.from(root.querySelectorAll("button,[role='button'],h1,h2,h3,h4,h5,h6,div,span,p"))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isVisible)
      .filter((element) => {
        const text = normalizeCharacterHeaderText(element.textContent);
        const own = normalizeCharacterHeaderText(ownControlText(element));
        return CHARACTER_HEADER_RE.test(text) || CHARACTER_HEADER_RE.test(own);
      })
      .sort((a, b) => {
        const depth = (node) => {
          let value = 0;
          for (let cur = node; cur && cur !== root; cur = cur.parentElement) value += 1;
          return value;
        };
        return depth(b) - depth(a);
      });

    const selected = [];
    for (const candidate of candidates) {
      if (selected.some((child) => candidate.contains(child))) {
        continue;
      }
      selected.push(candidate);
    }
    return selected.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top || ar.left - br.left;
    });
  }

  function getCharacterHeaderIndex(element) {
    const direct = normalizeCharacterHeaderText(ownControlText(element));
    const full = normalizeCharacterHeaderText(element?.textContent);
    const match = CHARACTER_HEADER_RE.exec(direct) || CHARACTER_HEADER_RE.exec(full);
    return match ? Number.parseInt(match[1], 10) : Number.NaN;
  }

  function findCharacterCardFromHeader(header) {
    if (!header) {
      return null;
    }
    let node = header;
    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      const indices = new Set(
        getCharacterHeaderElements(node)
          .map(getCharacterHeaderIndex)
          .filter(Number.isFinite)
      );
      const text = String(node.textContent || "");
      const hasBodySignal = Boolean(node.querySelector(CHAR_WRAPPER_SELECTOR))
        || /(?:\bposition\b|\btokens?\b|ai[’']?s choice|undesired content|\bprompt\b)/i.test(text);
      if (indices.size === 1 && rect.width >= 180 && rect.height >= 60 && hasBodySignal) {
        return node;
      }
      if (indices.size > 1) {
        break;
      }
      node = node.parentElement;
    }
    return header.parentElement;
  }

  function getCharacterContainers() {
    // Current NovelAI exposes a stable, ordinal class on every real Character
    // card: .character-prompt-input-N.  Prefer those roots directly instead of
    // inferring card boundaries from text.  The page can keep both desktop and
    // mobile copies in the DOM, so group roots by their UI surface and use one
    // coherent visible surface only.
    const directRoots = Array.from(document.querySelectorAll('.character-prompt-input,[class*="character-prompt-input-"]'))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isRenderedControl)
      .map((element) => {
        const className = Array.from(element.classList || []).find((name) => /^character-prompt-input-\d+$/.test(name));
        const match = className && /-(\d+)$/.exec(className);
        return { element, index: match ? Number.parseInt(match[1], 10) : Number.NaN };
      })
      .filter(({ index }) => Number.isFinite(index));

    if (directRoots.length) {
      const groups = new Map();
      for (const entry of directRoots) {
        const surface = entry.element.closest('.settings-panel,.mobile-tray-contents') || entry.element.parentElement;
        if (!groups.has(surface)) groups.set(surface, []);
        groups.get(surface).push(entry);
      }
      const viewportArea = (element) => {
        if (!(element instanceof Element)) {
          return 0;
        }
        const rect = element.getBoundingClientRect();
        const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
        const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        return width * height;
      };
      const best = Array.from(groups.entries())
        .map(([surface, entries]) => {
          const unique = new Map();
          for (const entry of entries) {
            if (!unique.has(entry.index)) unique.set(entry.index, entry.element);
          }
          const cards = Array.from(unique.values());
          const cardAreas = cards.map(viewportArea);
          const visibleCardCount = cardAreas.filter((area) => area > 0).length;
          const visibleArea = cardAreas.reduce((sum, area) => sum + area, 0);
          const surfaceArea = surface && isRenderedControl(surface) ? viewportArea(surface) : 0;
          const surfaceIsOnscreen = surfaceArea > 0 || visibleCardCount > 0;

          // NovelAI can retain an off-screen mobile tray with the old Character
          // count while the visible desktop panel has already rerendered.  The
          // old scoring preferred whichever surface had MORE cards, so after a
          // successful 4 → 3 deletion it could keep reporting the stale hidden
          // four-card copy.  Always prefer an on-screen coherent surface first.
          const score = (surfaceIsOnscreen ? 1e15 : 0)
            + visibleCardCount * 1e12
            + visibleArea * 1e3
            + surfaceArea
            + unique.size;
          return { unique, score };
        })
        .sort((a, b) => b.score - a.score)[0];
      if (best?.unique?.size) {
        return Array.from(best.unique.entries())
          .sort((a, b) => a[0] - b[0])
          .map((entry) => entry[1]);
      }
    }

    // Fallback for older NovelAI builds without ordinal card classes.
    const root = document;
    const indexed = new Map();
    for (const header of getCharacterHeaderElements(root)) {
      const index = getCharacterHeaderIndex(header);
      const card = findCharacterCardFromHeader(header);
      if (Number.isFinite(index) && card && !indexed.has(index)) {
        indexed.set(index, card);
      }
    }
    if (!indexed.size) {
      const promptBoxes = Array.from(root.querySelectorAll(CHAR_WRAPPER_SELECTOR));
      let fallbackIndex = 1;
      for (const box of promptBoxes) {
        let node = box.parentElement;
        let found = null;
        while (node && node !== document.body) {
          const hasUcTab = Array.from(node.querySelectorAll("button"))
            .some((button) => !button.closest(`#${HOST_ID}`) && UC_TAB_RE.test(normalizeButtonText(button)));
          const charCount = node.querySelectorAll(CHAR_WRAPPER_SELECTOR).length;
          if (hasUcTab && charCount === 1) {
            found = node;
            break;
          }
          node = node.parentElement;
        }
        const container = found || box.parentElement;
        if (container && !Array.from(indexed.values()).includes(container)) {
          indexed.set(fallbackIndex, container);
          fallbackIndex += 1;
        }
      }
    }
    return Array.from(indexed.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
  }

  function getCharacterHeaderInContainer(container) {
    return getCharacterHeaderElements(container)[0] || null;
  }

  async function waitForCharacterEditorAt(index, attempts = 12) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const container = getCharacterContainers()[index];
      const editor = getCharacterBoxEditor(container);
      if (editor) {
        return { container, editor };
      }
      await delay(100);
    }
    return { container: getCharacterContainers()[index] || null, editor: null };
  }

  function getCharacterActivationTarget(container, attempt) {
    if (!container) {
      return null;
    }
    const header = getCharacterHeaderInContainer(container);
    const cardRect = container.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect?.() || cardRect;

    // In the current UI, only the selected character owns the large ProseMirror
    // editor. Other cards are compact previews. Clicking the visible prompt
    // preview (not the reorder/check/trash buttons) selects that card.
    if (attempt === 1 || attempt === 2) {
      const x = Math.min(cardRect.right - 28, cardRect.left + Math.max(42, Math.min(92, cardRect.width * 0.24)));
      const y = Math.min(cardRect.bottom - 26, headerRect.bottom + (attempt === 1 ? 34 : 58));
      const atPoint = document.elementFromPoint(x, y);
      if (atPoint && container.contains(atPoint)) {
        return atPoint;
      }
    }

    const broadClickable = Array.from(container.querySelectorAll("[role='button'],[tabindex]"))
      .filter((element) => !element.closest(`#${HOST_ID}`))
      .filter(isVisible)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const label = accessibleControlText(element);
        // Exclude the small header controls (move up/down, enable) and trash.
        if (/delete|remove|trash|삭제|undesired|prompt/i.test(label)) {
          return false;
        }
        if (rect.width < 42 && rect.height < 42 && rect.left > cardRect.left + cardRect.width * 0.68) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })[0] || null;

    const targets = [
      header?.closest("[role='button'],[tabindex]"),
      header,
      header?.parentElement,
      broadClickable,
      container,
    ].filter((target, pos, list) => target && list.indexOf(target) === pos);
    return targets[attempt] || targets[targets.length - 1] || null;
  }

  async function ensureCharacterExpandedAt(index) {
    // Prompt writing does not require locating the trash button. The previous
    // implementation used the selected card's icon-only control as proof of
    // selection, but NovelAI reuses that icon for prompt/position actions. That
    // made queue startup spend many seconds retrying every Character card.
    let resolved = await waitForCharacterEditorAt(index, 1);
    if (resolved.editor) {
      return resolved;
    }

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const container = getCharacterContainers()[index];
      if (!container) {
        break;
      }
      const target = getCharacterActivationTarget(container, attempt);
      if (!target) {
        continue;
      }
      clickControlLikeUser(target);
      resolved = await waitForCharacterEditorAt(index, 14);
      if (resolved.editor) {
        return resolved;
      }
    }
    return resolved;
  }

  function getCharacterSurface(container) {
    if (!(container instanceof Element)) {
      return null;
    }
    return container.closest('.settings-panel,.mobile-tray-contents') || container.parentElement || null;
  }

  function getCharacterContainersInSurface(surface) {
    if (!(surface instanceof Element) || !surface.isConnected) {
      return [];
    }
    const indexed = new Map();
    for (const element of surface.querySelectorAll('.character-prompt-input,[class*="character-prompt-input-"]')) {
      if (element.closest(`#${HOST_ID}`)) {
        continue;
      }
      const className = Array.from(element.classList || [])
        .find((name) => /^character-prompt-input-\d+$/.test(name));
      const match = className && /-(\d+)$/.exec(className);
      const index = match ? Number.parseInt(match[1], 10) : Number.NaN;
      if (Number.isFinite(index) && !indexed.has(index)) {
        indexed.set(index, element);
      }
    }
    return Array.from(indexed.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1]);
  }

  function exactCharacterTrashButton(container) {
    if (!(container instanceof Element)) {
      return null;
    }
    const characterRoot = container.matches('.character-prompt-input,[class*="character-prompt-input-"]')
      ? container
      : container.closest('.character-prompt-input,[class*="character-prompt-input-"]')
        || container.querySelector('.character-prompt-input,[class*="character-prompt-input-"]');
    if (!(characterRoot instanceof Element)) {
      return null;
    }

    // User-confirmed NovelAI trash control:
    // <button><div class="... sc-7d0727b8-33 ..." style="height:16px;width:16px"></div></button>
    // Position buttons use a 14px icon nested inside a <span>, so requiring the
    // icon to be the DIRECT child of the button keeps those controls excluded.
    const buttons = Array.from(characterRoot.querySelectorAll('button'));
    for (const button of buttons) {
      if (button.closest(`#${HOST_ID}`) || button.disabled || button.getAttribute('aria-disabled') === 'true') {
        continue;
      }
      const icon = Array.from(button.children).find((child) => child.matches?.('.sc-7d0727b8-33'));
      if (!icon) {
        continue;
      }
      const style = getComputedStyle(icon);
      const rect = icon.getBoundingClientRect();
      const width = Number.parseFloat(style.width) || rect.width;
      const height = Number.parseFloat(style.height) || rect.height;
      if (width >= 15 && width <= 17.5 && height >= 15 && height <= 17.5 && isRenderedControl(button)) {
        return button;
      }
    }
    return null;
  }

  async function activateCharacterForDeletion(index, surface) {
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const containers = getCharacterContainersInSurface(surface);
      const container = containers[index];
      if (!container) {
        return { container: null, button: null };
      }
      const existing = exactCharacterTrashButton(container);
      if (existing) {
        return { container, button: existing };
      }
      const target = getCharacterActivationTarget(container, attempt)
        || getCharacterHeaderInContainer(container)
        || container;
      clickControlLikeUser(target);
      await delay(140);
    }
    const container = getCharacterContainersInSurface(surface)[index] || null;
    return { container, button: exactCharacterTrashButton(container) };
  }

  function findCharacterDeleteConfirmationButton() {
    const scopes = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .filter(isVisible);
    for (const scope of scopes) {
      const button = Array.from(scope.querySelectorAll("button,[role='button']"))
        .filter(isRenderedControl)
        .filter((element) => !element.closest(`#${HOST_ID}`))
        .find((element) => {
          const label = accessibleControlText(element);
          return /delete|remove|confirm|yes|삭제|지우기|확인/i.test(label)
            && !/cancel|no|취소|아니/i.test(label);
        });
      if (button) {
        return button;
      }
    }
    return null;
  }

  async function waitForCharacterCountBelow(before, surface, attempts = 36) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await delay(120);
      const sameSurfaceCount = getCharacterContainersInSurface(surface).length;
      if (sameSurfaceCount < before) {
        return true;
      }
      if ((!surface || !surface.isConnected) && getCharacterContainers().length < before) {
        return true;
      }
    }
    return false;
  }

  async function removeLastCharacterBox(surface) {
    const beforeContainers = getCharacterContainersInSurface(surface);
    const before = beforeContainers.length;
    if (!before) {
      return true;
    }

    const lastIndex = before - 1;
    const initialContainer = beforeContainers[lastIndex];
    try {
      initialContainer.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (error) {
      void error;
    }
    await delay(100);

    const activated = await activateCharacterForDeletion(lastIndex, surface);
    const button = activated.button;
    if (!button || !activated.container?.contains(button)) {
      setStatus(`Character ${before}에서 16×16 휴지통 버튼(sc-7d0727b8-33)을 찾지 못했습니다.`, 'warn');
      return false;
    }

    clickControlLikeUser(button);
    if (await waitForCharacterCountBelow(before, surface, 28)) {
      return true;
    }

    const confirmation = findCharacterDeleteConfirmationButton();
    if (confirmation) {
      clickControlLikeUser(confirmation);
      if (await waitForCharacterCountBelow(before, surface, 28)) {
        return true;
      }
    }

    setStatus(`Character ${before} 휴지통을 눌렀지만 삭제가 반영되지 않았습니다.`, 'warn');
    return false;
  }

  async function resetCharacterBoxes(surface) {
    let guard = 0;
    while (getCharacterContainersInSurface(surface).length > 0 && guard < 16) {
      const before = getCharacterContainersInSurface(surface).length;
      setStatus(`캐릭터 전체 삭제 중: ${before}개 남음`, 'ok');
      const removed = await removeLastCharacterBox(surface);
      if (!removed) {
        return false;
      }
      guard += 1;
      await delay(180);
    }
    return getCharacterContainersInSurface(surface).length === 0;
  }

  async function addMissingCharacterBoxes(segments, surface) {
    let containers = getCharacterContainersInSurface(surface);
    let guard = 0;
    while (containers.length < segments.length && guard < 16) {
      const added = await clickAddCharacterBox(segments[containers.length] || '', surface);
      if (!added) {
        return false;
      }
      containers = getCharacterContainersInSurface(surface);
      guard += 1;
    }
    return containers.length === segments.length;
  }

  async function ensureCharacterCardLayout(segments) {
    const targetCount = segments.length;
    const currentContainers = getCharacterContainers();
    const currentCount = currentContainers.length;
    const surface = getCharacterSurface(currentContainers[0])
      || Array.from(document.querySelectorAll('.settings-panel,.mobile-tray-contents')).find(isVisible)
      || null;

    // Keep matching layouts intact. Whenever the count changes (4→2, 2→4, etc.),
    // use the simple deterministic path requested by the user: delete ALL cards,
    // then add exactly the target number again using any visible gender seed.
    if (currentCount !== targetCount) {
      setStatus(`캐릭터 카드 재구성 중: ${currentCount}개 전체 삭제 → ${targetCount}개 추가`, 'ok');
      const cleared = await resetCharacterBoxes(surface);
      if (!cleared) {
        return false;
      }
      if (targetCount > 0) {
        const added = await addMissingCharacterBoxes(segments, surface);
        if (!added) {
          return false;
        }
      }
    }

    return characterCountForSurface(surface) === targetCount;
  }


  // Within `scope`, return the visible editable element that is NOT a prompt box
  // (i.e. the Undesired Content editor) and, optionally, not inside a character
  // container (for the base UC). Excludes our own panel.
  function findUcEditorInScope(scope, { excludeContainers = [] } = {}) {
    return Array.from(scope.querySelectorAll("[contenteditable]"))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => el.isContentEditable)
      .filter((el) => !el.closest(`#${HOST_ID}`))
      .filter((el) => !isPromptEditor(el))
      .filter((el) => !excludeContainers.some((c) => c.contains(el)))
      .filter(isVisible)[0] || null;
  }

  // NovelAI V4 reuses ONE box per scope and swaps its contents by tab. For a
  // character, the "Prompt" and "Undesired Content" tabs share the same wrapper
  // class (e.g. prompt-input-box-character-prompts-1), so the ONLY reliable way
  // to target the prompt vs the negative is to click the right tab first, then
  // read/write whatever box is now visible. `which` is "prompt" or "uc".
  async function revealTabInScope(scope, which, { excludeCharacterBoxes = false } = {}) {
    if (!scope) {
      return false;
    }
    const re = which === "uc" ? UC_TAB_RE : PROMPT_TAB_RE;
    const tab = findTabButton(scope, re, { excludeCharacterBoxes });
    if (tab) {
      tab.click();
      await delay(180);
      return true;
    }
    return false;
  }

  // The single visible editable box inside a character container — whatever the
  // currently active tab (Prompt or Undesired Content) is showing.
  function getCharacterBoxEditor(container) {
    if (!container) {
      return null;
    }

    const valid = (el) => el instanceof HTMLElement
      && el.isContentEditable
      && !el.closest(`#${HOST_ID}`)
      && isVisible(el);

    // Preferred selector for older/current builds that expose a stable wrapper.
    const explicit = Array.from(container.querySelectorAll(`${CHAR_WRAPPER_SELECTOR} [contenteditable]`))
      .filter(valid)[0];
    if (explicit) {
      return explicit;
    }

    // Current NovelAI can render the ProseMirror editor without the historical
    // prompt-input-box-character-prompts-N class. Once we are already scoped to
    // a single Character N card, its only visible contenteditable is the active
    // Prompt/Undesired Content editor, so class-free lookup is safe here.
    const scoped = Array.from(container.querySelectorAll("[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable]"))
      .filter(valid)[0];
    if (scoped) {
      return scoped;
    }

    // Geometry fallback: a card ancestor can be unusually shallow after a React
    // rerender. Find the editable whose vertical centre sits below this card's
    // header and above the next Character N header. Never allow the base editor.
    const root = document;
    const header = getCharacterHeaderInContainer(container);
    if (!header) {
      return null;
    }
    const headers = getCharacterHeaderElements(root);
    const index = headers.indexOf(header);
    const top = header.getBoundingClientRect().top - 4;
    const nextTop = index >= 0 && headers[index + 1]
      ? headers[index + 1].getBoundingClientRect().top - 4
      : Number.POSITIVE_INFINITY;
    const base = getBasePromptEditor();
    return Array.from(root.querySelectorAll("[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable]"))
      .filter(valid)
      .filter((el) => el !== base)
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        return mid > top && mid < nextTop;
      })[0] || null;
  }

  // Reveal the UC tab in `scope` if needed, write, then restore the Prompt tab.
  // The editor is resolved AFTER the tab switch so we always target the box that
  // is actually visible. Returns {ok} — never writes into a prompt editor.
  async function writeNegativeIntoScope(scope, resolveEditor, text, { excludeCharacterBoxes = false } = {}) {
    let editor = resolveEditor();
    let switchedTab = false;
    if (!editor) {
      const ucTab = findTabButton(scope, UC_TAB_RE, { excludeCharacterBoxes });
      if (ucTab) {
        ucTab.click();
        switchedTab = true;
        await delay(200);
        editor = resolveEditor();
      }
    }
    if (!editor || isPromptEditor(editor)) {
      if (switchedTab) {
        const promptTab = findTabButton(scope, PROMPT_TAB_RE, { excludeCharacterBoxes });
        if (promptTab) {
          promptTab.click();
          await delay(110);
        }
      }
      return { ok: false };
    }
    setEditablePlainText(editor, text);
    await delay(150);
    if (switchedTab) {
      const promptTab = findTabButton(scope, PROMPT_TAB_RE, { excludeCharacterBoxes });
      if (promptTab) {
        promptTab.click();
        await delay(110);
      }
    }
    return { ok: true };
  }

  // Base (image-level) UC editor: the non-prompt visible editor in the base area
  // that is not inside any character container.
  function getBaseNegativeEditor() {
    const root = getBaseArea() || document;
    // The base UC box has its own dedicated class, distinct from per-character
    // UC boxes (which reuse the character-prompt wrapper). Prefer it directly.
    const direct = Array.from(root.querySelectorAll(`${UC_SELECTOR} [contenteditable]`))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => el.isContentEditable)
      .filter((el) => !el.closest(`#${HOST_ID}`))
      .filter(isVisible)[0];
    if (direct) {
      return direct;
    }
    return findUcEditorInScope(root, { excludeContainers: getCharacterContainers() });
  }
  function getNegativePromptEditor() {
    return getBaseNegativeEditor();
  }

  async function applyBaseNegativeToNovelAi(text) {
    if (text == null || String(text).trim() === "") {
      return { ok: true, skipped: true };
    }
    const scope = getBaseArea() || document.body;
    await revealTabInScope(scope, "uc", { excludeCharacterBoxes: true });
    const editor = getBaseNegativeEditor();
    if (!editor) {
      await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
      setStatus("베이스 네거티브(Undesired Content) 입력란을 찾지 못해 건너뛰었습니다.", "warn");
      return { ok: false };
    }
    setEditablePlainText(editor, text);
    await delay(150);
    await revealTabInScope(scope, "prompt", { excludeCharacterBoxes: true });
    return { ok: true };
  }

  function getCharacterNegativeEditor(container) {
    return findUcEditorInScope(container);
  }

  function splitCharacterBlocks(value) {
    // ASCII/full-width double semicolons are accepted. Empty blocks are removed.
    return String(value == null ? "" : value)
      .split(/\s*(?:;;|；；)\s*/u)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  // Apply per-character negatives to each character's own Undesired Content box.
  // ";;" separates negatives per character; a single block applies to character 1.
  async function applyCharacterNegativesToNovelAi(text) {
    if (text == null || String(text).trim() === "") {
      return { ok: true, skipped: true };
    }
    const segments = splitCharacterBlocks(text);
    const containers = getCharacterContainers();
    if (!containers.length) {
      setStatus("캐릭터 박스를 찾지 못해 캐릭터 네거티브를 건너뛰었습니다.", "warn");
      return { ok: false };
    }
    let applied = 0;
    for (let i = 0; i < segments.length && i < containers.length; i += 1) {
      const seg = segments[i];
      if (!seg) {
        continue;
      }
      const expanded = await ensureCharacterExpandedAt(i);
      let container = expanded.container;
      if (!container) {
        continue;
      }
      await revealTabInScope(container, "uc");
      container = getCharacterContainers()[i] || container;
      const editor = getCharacterBoxEditor(container);
      if (editor) {
        setEditablePlainText(editor, seg);
        await delay(140);
        applied += 1;
      }
      await revealTabInScope(container, "prompt");
    }
    if (!applied) {
      setStatus("캐릭터 네거티브를 적용하지 못했습니다. (캐릭터 박스의 Undesired Content 칸을 못 찾음)", "warn");
      return { ok: false };
    }
    return { ok: true, applied };
  }

  // Write each character segment into NovelAI's real character prompt box,
  // adding boxes when needed. This is what makes the queue actually drive the
  // output (the "|" merge into the base box is ignored once character boxes exist).
  async function applyCharacterPromptsToNovelAi(segments) {
    if (!segments.length) {
      return { ok: true, applied: 0, requested: 0 };
    }

    // Keep the card count/order/gender aligned with the ;; blocks. A stale
    // Female card for a 1boy block is deleted and recreated as Male.
    const layoutReady = await ensureCharacterCardLayout(segments);
    let containers = getCharacterContainers();
    if (!layoutReady) {
      return {
        ok: false,
        error: `캐릭터 카드 재구성에 실패했습니다. 현재 ${containers.length}개 / 필요한 ${segments.length}개입니다. 잘못된 캐릭터 구성으로는 생성하지 않습니다.`,
      };
    }

    if (!containers.length) {
      // Never merge character text into Base Prompt. NovelAI ignores that legacy
      // pipe form when Character Prompts are enabled, and it visibly contaminates
      // the user's base prompt. Stop with a clear error instead.
      return {
        ok: false,
        error: "캐릭터 카드는 생성됐지만 Character N 영역을 찾지 못했습니다. 페이지를 새로고침한 뒤 다시 실행해 주세요.",
      };
    }

    const count = Math.min(segments.length, containers.length);
    let applied = 0;
    for (let i = 0; i < count; i += 1) {
      const expanded = await ensureCharacterExpandedAt(i);
      let container = expanded.container;
      if (!container) {
        setStatus(`캐릭터 ${i + 1} 카드를 찾지 못했습니다.`, "warn");
        continue;
      }
      await revealTabInScope(container, "prompt");
      // Tab switching may rerender the card, so resolve it again by ordinal.
      const current = await waitForCharacterEditorAt(i, 10);
      const editor = current.editor;
      if (!editor) {
        setStatus(`캐릭터 ${i + 1} 입력 칸을 펼치지 못했습니다.`, "warn");
        continue;
      }
      const written = await setCharacterPromptText(editor, segments[i]);
      if (!written) {
        setStatus(`캐릭터 ${i + 1} 프롬프트 일부가 입력되지 않았습니다.`, "warn");
      } else {
        applied += 1;
      }
      await delay(140);
    }
    return { ok: applied > 0, applied, requested: segments.length };
  }


  // Apply a queue item's base prompt (to the base box) and character prompt
  // (to the character boxes) separately.
  async function applyStructuredPrompt(basePrompt, characterPrompt) {
    let base = basePrompt == null ? "" : String(basePrompt);
    let segments = splitCharacterBlocks(characterPrompt);
    // If the base prompt itself carries "|" character pipes, peel them off so the
    // base box never duplicates character content. Use them as characters only
    // when the character field is empty.
    // 이 블록 전체를 삭제하거나 주석 처리하세요.
    /*
    if (base.includes("|")) {
      const parts = base.split("|");
      base = parts[0].trim();
      const basePipes = parts.slice(1).map((part) => part.trim()).filter(Boolean);
      if (!segments.length) {
        segments = basePipes;
      }
    }
    */
    if (base.trim() !== "") {
      const baseResult = await applyPromptToNovelAi(base);
      if (!baseResult.ok) {
        return baseResult;
      }
    }
    if (segments.length) {
      const charResult = await applyCharacterPromptsToNovelAi(segments);
      if (!charResult.ok) {
        return charResult;
      }
      if (charResult.applied < charResult.requested) {
        setStatus(`캐릭터 박스가 부족해 ${charResult.applied}/${charResult.requested}개만 적용했습니다.`, "warn");
      }
    }
    return { ok: true };
  }

  function findCurrentImage() {
    return Array.from(document.images)
      .filter(isVisible)
      .filter((image) => image.src && !image.src.startsWith("chrome-extension://"))
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      })[0] || null;
  }

  function checkGenerationCost() {
    const genButton = findGenerateButton();
    if (!genButton) {
      return "";
    }
    const costText = (genButton.textContent || "").match(/(\d+)\s*Anlas/i)?.[1] || "";
    const numericCost = Number.parseInt(costText, 10);
    if (Number.isFinite(numericCost) && numericCost > 0) {
      return `생성 비용이 ${numericCost} Anlas입니다. 비용이 0이 아니면 자동 생성을 시작하지 않습니다.`;
    }
    return "";
  }

  function runSafetyChecks({ alertUser = true } = {}) {
    if (!location.href.startsWith("https://novelai.net/image")) {
      const message = "NovelAI 이미지 페이지에서만 사용할 수 있습니다.";
      setStatus(message, "warn");
      if (alertUser) {
        alert(message);
      }
      return false;
    }
    const warning = checkGenerationCost();
    if (warning) {
      setStatus(warning, "warn");
      if (alertUser) {
        alert(warning);
      }
      return false;
    }
    return true;
  }

  async function playSound(filename) {
    const { volume = 0.5 } = await storageGet("sync", ["volume"]);
    const parsedVolume = Number(volume);
    const safeVolume = Number.isFinite(parsedVolume)
      ? Math.max(0, Math.min(1, parsedVolume))
      : 0.5;

    // Content-script audio is subject to the host page's autoplay policy.
    // Route playback through an extension offscreen document instead so both
    // click-triggered start sounds and asynchronous completion sounds work.
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: "playExtensionSound",
        filename,
        volume: safeVolume,
      }, (response) => {
        void chrome.runtime.lastError;
        resolve(Boolean(response?.ok));
      });
    });
  }

  function defaultSaveName() {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
    ].join("");
    return `NAI_${stamp}`;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("FileReader 실패"));
      reader.readAsDataURL(blob);
    });
  }

  // Turn the live <img> into a self-contained data: URL *inside the page*, while
  // the blob: URL is still alive. NovelAI revokes the previous blob when the next
  // generation starts, so passing the raw blob: URL to the background download
  // races that revocation and occasionally writes an empty file. A data: URL has
  // the bytes baked in and never goes stale.
  async function captureImageDataUrl(image) {
    // Preferred path: fetch the blob and keep the exact PNG bytes.
    try {
      const response = await fetch(image.src);
      const blob = await response.blob();
      if (blob && blob.size > 0) {
        return await blobToDataUrl(blob);
      }
    } catch (error) {
      void error;
    }
    // Fallback: re-encode via canvas (works for same-origin blob/https images).
    try {
      if (!(image.complete && image.naturalWidth > 0)) {
        try {
          await image.decode();
        } catch (decodeError) {
          void decodeError;
        }
      }
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        // Free the (potentially multi-MB) bitmap immediately instead of waiting
        // for GC. Over a long batch this keeps the renderer's peak memory down.
        canvas.width = 0;
        canvas.height = 0;
        if (dataUrl && dataUrl.length > "data:image/png;base64,".length) {
          return dataUrl;
        }
      }
    } catch (error) {
      void error;
    }
    return null;
  }

  // An <img> qualifies as a freshly generated result only when it is fully
  // decoded, at least MIN_IMAGE_DIM on each side in its *natural* resolution
  // (so scaled-up previews are rejected), and not the one we just saved.
  function isFreshGeneratedImage(image, excludeSrc) {
    if (!image || !image.src) {
      return false;
    }
    if (excludeSrc && image.src === excludeSrc) {
      return false;
    }
    if (!image.complete) {
      return false;
    }
    return image.naturalWidth >= MIN_IMAGE_DIM && image.naturalHeight >= MIN_IMAGE_DIM;
  }

  // Roughly the size of an empty/near-blank PNG payload. Real generations are
  // far larger, so anything under this floor is treated as a failed capture.
  const MIN_DATAURL_LENGTH = 3000;

  async function maybeDownloadCurrentImage() {
    const { autoSaveEnabled = true } = await storageGet("sync", ["autoSaveEnabled"]);
    if (autoSaveEnabled === false) {
      return;
    }

    // Wait for a genuinely NEW, fully-decoded, full-resolution image. The
    // generate button can re-enable a beat before the previous image is swapped
    // out, and NovelAI briefly shows a low-res preview during the swap — both
    // would otherwise be captured as blank/duplicate files.
    const previousSrc = saveContext.lastSavedSrc;
    let image = findCurrentImage();
    for (let i = 0; i < 16; i += 1) {
      if (isFreshGeneratedImage(image, previousSrc)) {
        break;
      }
      await delay(250);
      image = findCurrentImage();
      if (image?.src && !image.complete) {
        try {
          await image.decode();
        } catch (error) {
          void error;
        }
      }
    }
    if (!isFreshGeneratedImage(image, previousSrc)) {
      // Last resort: accept any complete, full-size image even if src looks
      // unchanged, rather than silently skipping a real result.
      image = findCurrentImage();
      if (!image?.src || !image.complete || image.naturalWidth < MIN_IMAGE_DIM) {
        setStatus("자동 저장할 이미지를 찾지 못했습니다.", "warn");
        return;
      }
    }

    // Capture to a data URL, retrying a few times to dodge blob/timing races.
    let dataUrl = null;
    for (let i = 0; i < 6 && !dataUrl; i += 1) {
      const candidate = await captureImageDataUrl(image);
      if (candidate && candidate.length >= MIN_DATAURL_LENGTH) {
        dataUrl = candidate;
        break;
      }
      await delay(250);
      const fresh = findCurrentImage();
      if (fresh?.src && fresh.complete && fresh.naturalWidth >= MIN_IMAGE_DIM) {
        image = fresh;
      }
    }
    if (!dataUrl) {
      setStatus("이미지를 읽지 못해 이번 저장은 건너뛰었습니다.", "warn");
      return;
    }

    saveContext.lastSavedSrc = image.src;
    saveContext.counter += 1;
    const base = Store.sanitizeFileName(saveContext.baseName || defaultSaveName());
    const folder = (ui.folderInput?.value || "").trim() || "NovelAI";
    chrome.runtime.sendMessage({
      action: "downloadImage",
      imageUrl: dataUrl,
      fileName: `${base} (${saveContext.counter})`,
      folder,
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  // ---------------------------------------------------------------------------
  // auto-generation engine
  // ---------------------------------------------------------------------------
  function isGenerationCancelled(shouldContinue) {
    return typeof shouldContinue === "function" && !shouldContinue();
  }

  async function clickGenerate({ shouldContinue = null, silent = false } = {}) {
    if (isGenerationCancelled(shouldContinue)) {
      return { ok: false, cancelled: true };
    }
    if (!runSafetyChecks({ alertUser: !silent })) {
      return { ok: false, error: "안전 점검에 실패했습니다." };
    }
    const button = findGenerateButton();
    if (!button) {
      const message = "생성 버튼을 찾지 못했습니다.";
      setStatus(message, "warn");
      return { ok: false, error: message };
    }
    if (button.disabled) {
      return { ok: false, error: "생성 버튼이 아직 비활성화 상태입니다." };
    }
    button.click();
    return { ok: true };
  }

  function clearAutoTimers() {
    if (autoRun.timerId) {
      clearInterval(autoRun.timerId);
      autoRun.timerId = null;
    }
    if (autoRun.timeoutId) {
      clearTimeout(autoRun.timeoutId);
      autoRun.timeoutId = null;
    }
  }

  async function stopAutoGenerate({ playAudio = false, force = false } = {}) {
    // If an image is currently being generated, let it finish and get saved
    // before we tear everything down — otherwise the last image is lost. A
    // second stop click (force) skips the wait and stops immediately.
    if (!force && autoRun.active && autoRun.waitingForCompletion && !autoRun.stopAfterCurrent) {
      autoRun.stopAfterCurrent = true;
      renderControls();
      setStatus("정지 대기 중 — 마지막 이미지를 저장한 뒤 정지합니다. (다시 누르면 즉시 정지)", "warn");
      return { ok: true, pending: true };
    }
    return finalizeStop({ playAudio });
  }

  async function finalizeStop({ playAudio = false } = {}) {
    const wasActive = autoRun.active;
    clearAutoTimers();
    autoRun.token += 1;
    autoRun.active = false;
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
    autoRun.stopAfterCurrent = false;
    autoRun.onComplete = null;
    if (queueRun.active && !queueRun.advancing) {
      cancelQueueRun();
    }
    await storageSet("sync", { autoClickEnabled: false });
    renderControls();
    if (playAudio && wasActive) {
      await playSound("stop.mp3");
    }
    if (!queueRun.active) {
      setStatus(wasActive ? "자동 생성을 중지했습니다." : "자동 생성이 실행 중이 아닙니다.", wasActive ? "ok" : "warn");
    }
    return { ok: true };
  }

  async function clickForAutoRun() {
    const token = autoRun.token;
    const result = await clickGenerate({
      silent: true,
      shouldContinue: () => autoRun.active && token === autoRun.token,
    });
    if (!result.ok) {
      return result;
    }
    autoRun.count += 1;
    autoRun.waitingForCompletion = true;
    autoRun.waitingForExistingGeneration = false;
    autoRun.ignoreReadyUntil = Date.now() + 900;
    renderControls();
    if (!queueRun.active) {
      setStatus(`자동 생성 진행 중: ${autoRun.count}${autoRun.target ? ` / ${autoRun.target}` : ""}`, "ok");
    }
    return result;
  }

  async function completeAutoRun() {
    const count = autoRun.completedCount || autoRun.count;
    clearAutoTimers();
    autoRun.active = false;
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
    await storageSet("sync", { autoClickEnabled: false });
    renderControls();

    const onComplete = autoRun.onComplete;
    autoRun.onComplete = null;
    if (typeof onComplete === "function") {
      onComplete({ count });
      return;
    }
    await playSound("stop.mp3");
    chrome.runtime.sendMessage({ action: "showCompletionNotification", count }, () => {
      void chrome.runtime.lastError;
    });
    setStatus(`자동 생성을 완료했습니다. (${count}장)`, "ok");
  }

  async function scheduleNextAutoClick({ afterExistingGeneration = false } = {}) {
    const token = autoRun.token;
    const { intervalTime = 3 } = await storageGet("sync", ["intervalTime"]);
    const intervalSeconds = Math.max(0.1, Number.parseFloat(intervalTime) || 3);
    if (!autoRun.active || token !== autoRun.token) {
      return;
    }
    if (autoRun.timeoutId) {
      clearTimeout(autoRun.timeoutId);
    }
    if (afterExistingGeneration && !queueRun.active) {
      setStatus(`기존 생성 완료. ${intervalSeconds}초 후 시작합니다.`, "ok");
    }
    autoRun.timeoutId = setTimeout(async () => {
      autoRun.timeoutId = null;
      if (!autoRun.active || token !== autoRun.token) {
        return;
      }
      const result = await clickForAutoRun();
      if (!result.ok && !result.cancelled) {
        await stopAutoGenerate({ playAudio: true });
      }
    }, intervalSeconds * 1000);
  }

  async function handleAutoProgress() {
    const waiting = autoRun.waitingForCompletion || autoRun.waitingForExistingGeneration;
    if (!autoRun.active || !waiting || Date.now() < autoRun.ignoreReadyUntil) {
      return;
    }
    const button = findGenerateButton();
    if (!button || button.disabled) {
      return;
    }
    if (autoRun.waitingForExistingGeneration) {
      autoRun.waitingForExistingGeneration = false;
      renderControls();
      await scheduleNextAutoClick({ afterExistingGeneration: true });
      return;
    }
    autoRun.waitingForCompletion = false;
    await maybeDownloadCurrentImage();
    autoRun.completedCount = autoRun.count;
    recordImageCompletion();
    setStatus(progressLine() + liveEtaSuffix(), "ok");
    renderControls();
    if (autoRun.stopAfterCurrent) {
      setStatus("마지막 이미지를 저장하고 정지했습니다.", "ok");
      await finalizeStop({ playAudio: true });
      return;
    }
    if (autoRun.target > 0 && autoRun.count >= autoRun.target) {
      await completeAutoRun();
      return;
    }
    await scheduleNextAutoClick();
  }

  async function startAutoGenerate({ target = 0, saveName = "", applyPrompt = null, applyBasePrompt = null, applyCharacterPrompt = null, applyBaseNegative = null, applyCharacterNegative = null } = {}) {
    if (!runSafetyChecks({ alertUser: true })) {
      return { ok: false, error: "안전 점검 실패" };
    }
    await stopAutoGenerate({ playAudio: false });
    autoRun.token += 1;

    if (applyBasePrompt != null || applyCharacterPrompt != null) {
      const applied = await applyStructuredPrompt(applyBasePrompt, applyCharacterPrompt);
      if (!applied.ok) {
        setStatus(applied.error, "warn");
        return applied;
      }
    } else if (applyPrompt != null) {
      const applied = await applyPromptToNovelAi(applyPrompt);
      if (!applied.ok) {
        setStatus(applied.error, "warn");
        return applied;
      }
    }

    // Negatives are independent of the positive flow. The common/global negative
    // goes to the base Undesired Content; per-character negatives go to each
    // character's own Undesired Content. Failures are non-fatal (warn, continue).
    if (applyCharacterNegative != null && String(applyCharacterNegative).trim() !== "") {
      await applyCharacterNegativesToNovelAi(applyCharacterNegative);
    }
    if (applyBaseNegative != null && String(applyBaseNegative).trim() !== "") {
      await applyBaseNegativeToNovelAi(applyBaseNegative);
    }

    // Reset per-run name/counter, but carry the last saved image src forward so
    // the "is this a new image?" gate still works across queue-item boundaries
    // (otherwise the first save of the next item could grab the prior image).
    saveContext = {
      baseName: saveName || "",
      counter: 0,
      lastSavedSrc: saveContext.lastSavedSrc || "",
    };
    // For a standalone single run, restart timing. During a queue run the
    // tracker spans all items, so startQueueRun owns the reset instead.
    if (!queueRun.active) {
      resetEtaTracker();
    }
    autoRun.active = true;
    autoRun.count = 0;
    autoRun.completedCount = 0;
    autoRun.target = Math.max(0, Number.parseInt(target, 10) || 0);
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
    autoRun.stopAfterCurrent = false;
    autoRun.ignoreReadyUntil = 0;
    renderControls();

    await storageSet("sync", { autoClickEnabled: true });
    if (!queueRun.active) {
      await playSound("start.mp3");
    }

    autoRun.timerId = setInterval(() => {
      void handleAutoProgress();
    }, AUTO_REFRESH_MS);

    const generateButton = findGenerateButton();
    if (generateButton?.disabled) {
      autoRun.waitingForExistingGeneration = true;
      autoRun.ignoreReadyUntil = Date.now() + 900;
      renderControls();
      setStatus("기존 생성 완료를 기다린 뒤 시작합니다.", "ok");
      return { ok: true, delayed: true };
    }

    const result = await clickForAutoRun();
    if (!result.ok && !result.cancelled) {
      await stopAutoGenerate({ playAudio: true });
      return result;
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // queue
  // ---------------------------------------------------------------------------
  async function loadQueueState() {
    const result = await storageGet("local", [QUEUE_STORAGE_KEY]);
    queueState = Store.normalizeState(result[QUEUE_STORAGE_KEY]);
    return queueState;
  }

  async function persistQueueState() {
    queueState = Store.normalizeState(queueState);
    await storageSet("local", { [QUEUE_STORAGE_KEY]: queueState });
    renderQueue();
    renderControls();
  }

  function getItemIndexById(id) {
    return queueState.items.findIndex((item) => item.id === id);
  }

  async function addQueueItem() {
    await loadQueueState();
    let basePrompt = await readCurrentNaiPrompt();
    let characterPrompt = await readCurrentNaiCharacterPrompt();
    // If the base box itself uses NovelAI's "|" syntax and there are no separate
    // character boxes, split it so base/character land in the right fields.
    // 이 블록 역시 전체를 삭제하거나 주석 처리하세요.
    /*
    if (!characterPrompt && basePrompt.includes("|")) {
      const parts = basePrompt.split("|");
      basePrompt = parts[0].trim();
      characterPrompt = parts.slice(1).map((part) => part.trim()).filter(Boolean).join(" | ");
    }
    */
    const count = Math.max(1, Number.parseInt(ui.countInput?.value, 10) || 1);
    const negativePrompt = await readCurrentNaiCharacterNegative();
    const baseNegativePrompt = await readCurrentNaiNegativePrompt();
    const pattern = queueState.options.namePattern || "";
    const patterned = pattern.trim() ? Store.applyNamePattern(pattern, queueState.items.length) : "";
    const title = patterned || `대기열 ${queueState.items.length + 1}`;
    const newItem = Store.createItem({ title, basePrompt, baseNegativePrompt, characterPrompt, negativePrompt, count });
    queueState.items.push(newItem);
    selectedQueueId = newItem.id;
    await persistQueueState();
    setStatus(`대기열에 추가했습니다. (${queueState.items.length}개) 아래에서 편집하세요.`, "ok");
  }

  async function removeQueueItem(id) {
    const index = getItemIndexById(id);
    if (index < 0) {
      return;
    }
    queueState.items.splice(index, 1);
    if (selectedQueueId === id) {
      const next = queueState.items[index] || queueState.items[index - 1] || null;
      selectedQueueId = next ? next.id : null;
    }
    await persistQueueState();
  }

  async function moveQueueItem(id, direction) {
    const index = getItemIndexById(id);
    if (index < 0) {
      return;
    }
    const next = index + (direction < 0 ? -1 : 1);
    if (next < 0 || next >= queueState.items.length) {
      return;
    }
    const [moved] = queueState.items.splice(index, 1);
    queueState.items.splice(next, 0, moved);
    await persistQueueState();
  }

  async function reorderQueueItem(id, toIndex) {
    const from = getItemIndexById(id);
    if (from < 0) {
      return;
    }
    let dest = Math.max(0, Math.min(queueState.items.length - 1, toIndex));
    if (dest === from) {
      return;
    }
    const [moved] = queueState.items.splice(from, 1);
    queueState.items.splice(dest, 0, moved);
    await persistQueueState();
  }

  async function duplicateQueueItem(id) {
    const index = getItemIndexById(id);
    if (index < 0) {
      return;
    }
    const src = queueState.items[index];
    const copy = Store.createItem({
      title: nextDuplicateName(src.title),
      basePrompt: src.basePrompt,
      baseNegativePrompt: src.baseNegativePrompt,
      characterPrompt: src.characterPrompt,
      negativePrompt: src.negativePrompt,
      count: src.count,
    });
    queueState.items.splice(index + 1, 0, copy);
    selectedQueueId = copy.id;
    await persistQueueState();
    setStatus("항목을 복제했습니다.", "ok");
  }

  // "name" -> "name (2)", "name (2)" -> "name (3)"
  function nextDuplicateName(title) {
    const base = (title || "").trim() || "무제";
    const match = base.match(/^(.*?)\s*\((\d+)\)$/);
    const stem = match ? match[1].trim() : base;
    let n = match ? Number.parseInt(match[2], 10) + 1 : 2;
    const existing = new Set(queueState.items.map((it) => (it.title || "").trim()));
    let candidate = `${stem} (${n})`;
    while (existing.has(candidate)) {
      n += 1;
      candidate = `${stem} (${n})`;
    }
    return candidate;
  }

  // Apply the naming pattern to every item in order.
  async function applyNamePatternToAll() {
    const pattern = queueState.options.namePattern || "";
    if (!pattern.trim()) {
      setStatus("먼저 이름 패턴을 입력하세요. (예: char_{n})", "warn");
      return;
    }
    queueState.items.forEach((item, index) => {
      item.title = Store.applyNamePattern(pattern, index);
    });
    await persistQueueState();
    setStatus(`${queueState.items.length}개 항목 이름을 패턴으로 채웠습니다.`, "ok");
  }

  async function applyCountToAll(mode) {
    if (queueRun.active) {
      setStatus("대기열 실행 중에는 장수를 변경할 수 없습니다.", "warn");
      return;
    }
    if (!queueState.items.length) {
      setStatus("먼저 대기열에 항목을 추가하세요.", "warn");
      return;
    }
    const raw = Number.parseInt(ui.bulkCountInput?.value, 10);
    if (!Number.isFinite(raw) || raw < 1) {
      setStatus("적용할 장수를 1 이상으로 입력하세요.", "warn");
      return;
    }
    queueState.items.forEach((item) => {
      const next = mode === "add" ? (item.count || 0) + raw : raw;
      item.count = Store.normalizeCount(next);
    });
    await persistQueueState();
    const total = queueState.items.reduce((sum, item) => sum + (item.count || 0), 0);
    const verb = mode === "add" ? `장수를 +${raw}장씩 추가` : `장수를 ${raw}장으로 설정`;
    setStatus(`${queueState.items.length}개 항목 ${verb}했습니다. (총 ${total}장)`, "ok");
  }

  async function updateQueueItem(id, field, value) {
    const index = getItemIndexById(id);
    if (index < 0) {
      return;
    }
    if (field === "title") {
      queueState.items[index].title = Store.normalizeTitle(value);
    } else if (field === "basePrompt") {
      queueState.items[index].basePrompt = Store.normalizePrompt(value);
    } else if (field === "baseNegativePrompt") {
      queueState.items[index].baseNegativePrompt = Store.normalizePrompt(value);
    } else if (field === "characterPrompt") {
      queueState.items[index].characterPrompt = Store.normalizePrompt(value);
    } else if (field === "negativePrompt") {
      queueState.items[index].negativePrompt = Store.normalizePrompt(value);
    } else if (field === "count") {
      queueState.items[index].count = Store.normalizeCount(value);
    }
    await persistQueueState();
  }

  async function clearQueue() {
    if (queueRun.active) {
      setStatus("대기열 실행 중에는 비울 수 없습니다.", "warn");
      return;
    }
    queueState.items = [];
    await persistQueueState();
    setStatus("대기열을 비웠습니다.", "ok");
  }

  async function toggleQueueLoop() {
    await loadQueueState();
    queueState.options.loop = !queueState.options.loop;
    await persistQueueState();
  }

  function cancelQueueRun() {
    if (!queueRun.active) {
      return;
    }
    queueRun.active = false;
    queueRun.token += 1;
    autoRun.onComplete = null;
    const resolve = queueRun.resolveItem;
    queueRun.resolveItem = null;
    if (typeof resolve === "function") {
      resolve({ cancelled: true });
    }
  }

  function runQueueItemAt(index, runToken) {
    return new Promise((resolve) => {
      const item = queueRun.items[index];
      if (!item) {
        resolve({ ok: false, error: "잘못된 항목" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        queueRun.resolveItem = null;
        resolve(result);
      };
      queueRun.resolveItem = (result) => finish(result);

      (async () => {
        if (!queueRun.active || runToken !== queueRun.token) {
          finish({ cancelled: true });
          return;
        }
        queueRun.advancing = true;
        // The Generate button becomes enabled slightly before NovelAI finishes
        // committing the previous character-card UI. Give that React update one
        // turn to settle before deleting/recreating cards for the next item.
        if (index > 0) {
          try {
            document.activeElement?.blur?.();
          } catch (error) {
            void error;
          }
          await delay(550);
        }
        const itemBase = Store.effectiveBase(item, queueState.options);
        const itemBaseNeg = (item.baseNegativePrompt && item.baseNegativePrompt.trim())
          ? item.baseNegativePrompt
          : null;
        setStatus(`대기열 ${index + 1}/${queueRun.items.length} · ${item.title} · 프롬프트 적용 중`, "ok");
        const startResult = await startAutoGenerate({
          target: item.count,
          saveName: item.title,
          applyBasePrompt: itemBase && itemBase.trim() ? itemBase : null,
          applyCharacterPrompt: item.characterPrompt && item.characterPrompt.trim() ? item.characterPrompt : null,
          applyBaseNegative: itemBaseNeg,
          applyCharacterNegative: item.negativePrompt && item.negativePrompt.trim() ? item.negativePrompt : null,
        });
        queueRun.advancing = false;
        if (!startResult.ok && !startResult.delayed) {
          finish({ ok: false, error: startResult.error });
          return;
        }
        if (!queueRun.active || runToken !== queueRun.token) {
          finish({ cancelled: true });
          return;
        }
        // Register completion hook only after generation has started, because
        // startAutoGenerate internally stops the previous run (clearing onComplete).
        autoRun.onComplete = () => finish({ ok: true });
      })().catch((error) => {
        queueRun.advancing = false;
        autoRun.onComplete = null;
        finish({ ok: false, error: String(error?.message || error) });
      });
    });
  }

  async function startQueueRun() {
    if (queueRun.active) {
      return { ok: false };
    }
    await loadQueueState();
    if (!queueState.items.length) {
      setStatus("대기열이 비어 있습니다.", "warn");
      return { ok: false };
    }
    if (!runSafetyChecks({ alertUser: true })) {
      return { ok: false };
    }

    queueRun.active = true;
    queueRun.token += 1;
    const runToken = queueRun.token;
    queueRun.items = queueState.items.map((item) => Store.cloneJson(item));
    queueRun.loop = Boolean(queueState.options.loop);
    queueRun.index = 0;
    queueRun.totalGenerated = 0;
    resetEtaTracker();
    renderControls();
    renderQueue();
    // Keep the panel open during the run so the user can see the queue
    // and which item is currently generating (don't auto-collapse to the FAB).
    setActiveTab("queue");
    await playSound("start.mp3");

    let interrupted = false;
    let interruptionError = "";
    do {
      for (let i = 0; i < queueRun.items.length; i += 1) {
        if (!queueRun.active || runToken !== queueRun.token) {
          interrupted = true;
          break;
        }
        queueRun.index = i;
        renderQueue();
        renderControls();
        const item = queueRun.items[i];
        const totalAll = queueTotalImages();
        const overallAtStart = totalAll > 0
          ? Math.min(100, Math.round((queueRun.totalGenerated / totalAll) * 100))
          : 0;
        setStatus(`대기열 ${i + 1}/${queueRun.items.length} · ${item.title} · 항목 0/${item.count || 0}장 (0%) · 전체 ${overallAtStart}%`, "ok");
        const result = await runQueueItemAt(i, runToken);
        if (result?.cancelled || !queueRun.active || runToken !== queueRun.token) {
          interrupted = true;
          break;
        }
        if (!result?.ok) {
          interrupted = true;
          interruptionError = result?.error || "알 수 없는 오류";
          setStatus(`대기열 중단: ${interruptionError}`, "warn");
          break;
        }
        queueRun.totalGenerated += item.count;
      }
    } while (!interrupted && queueRun.active && runToken === queueRun.token && queueRun.loop);

    await finishQueueRun({ completedNormally: !interrupted, error: interruptionError });
    return { ok: true };
  }

  async function finishQueueRun({ completedNormally = false, error = "" } = {}) {
    const total = queueRun.totalGenerated;
    queueRun.active = false;
    queueRun.resolveItem = null;
    autoRun.onComplete = null;
    queueRun.index = 0;
    queueRun.items = [];
    queueRun.totalGenerated = 0;
    renderQueue();
    renderControls();
    if (completedNormally) {
      await playSound("stop.mp3");
      chrome.runtime.sendMessage({ action: "showCompletionNotification", count: total }, () => {
        void chrome.runtime.lastError;
      });
      setStatus(`대기열 작업을 모두 완료했습니다. (총 ${total}장)`, "ok");
    } else if (error) {
      setStatus(`대기열 중단: ${error}`, "warn");
    } else {
      setStatus("대기열 실행을 중지했습니다.", "warn");
    }
  }

  async function stopQueueRun() {
    // 자동 생성을 먼저 멈추도록 지시합니다.
    const result = await stopAutoGenerate({ playAudio: false });
    
    if (result.pending) {
      // 마지막 이미지를 기다리는 중(정지 대기)이라면 대기열 루프만 끊습니다.
      // 큐 활성 상태를 유지해야 UI가 자동 생성 탭으로 튕기지 않습니다.
      queueRun.token += 1; 
    } else {
      // 즉시 정지된 상태라면 대기열을 완전히 끕니다.
      cancelQueueRun();
    }
  }

  function exportQueue() {
    const envelope = Store.createExportEnvelope(queueState, {});
    const blob = new Blob([`${JSON.stringify(envelope, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nai-auto-saver-queue-${Date.now()}.json`;
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("대기열 JSON을 내보냈습니다.", "ok");
  }

  async function importQueueFromFile(file) {
    if (!file) {
      return;
    }
    try {
      const parsed = Store.parseExportEnvelope(await file.text());
      if (!parsed.ok) {
        setStatus(parsed.error, "warn");
        return;
      }
      queueState = parsed.queue;
      await persistQueueState();
      setStatus(`대기열을 가져왔습니다. (${queueState.items.length}개)`, "ok");
    } catch (error) {
      setStatus("대기열 JSON을 가져오지 못했습니다.", "warn");
    }
  }

  // ---------------------------------------------------------------------------
  // combination generator
  // ---------------------------------------------------------------------------
  let genSaveTimer = null;

  function downloadJson(obj, filename) {
    const blob = new Blob([`${JSON.stringify(obj, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // "1 hooded eyes" / "1. smiling" / "2) angry" / "3: ..." -> tag only.
  function stripLeadingNumber(line) {
    return String(line == null ? "" : line).replace(/^\s*\d+\s*[.)\]:．。、,-]?\s*/, "").trim();
  }

  function parseExpressionSet(text) {
    return String(text == null ? "" : text)
      .split(/\r?\n/)
      .map((line) => stripLeadingNumber(line))
      .filter((line) => line.length > 0);
  }

  function genCharRowHtml(data = {}) {
    const code = data.code != null ? String(data.code) : "";
    const appearance = data.appearance != null ? String(data.appearance) : "";
    const expressions = data.expressions != null ? String(data.expressions) : "";
    const negative = data.negative != null ? String(data.negative) : "";
    return `
      <div class="ias-gen-char-row">
        <div class="ias-gen-row-head">
          <input class="ias-input ias-gc-code" type="text" maxlength="40" placeholder="코드 (예: w)" value="${escapeAttr(code)}">
          <button class="ias-icon-btn ias-gc-del" type="button" title="이 캐릭터 삭제">${icon("delete", 16)}</button>
        </div>
        <label class="ias-gc-label">외형 태그</label>
        <textarea class="ias-input ias-gc-appear" rows="2" placeholder="예: girl, black hair, long hair">${escapeHtml(appearance)}</textarea>
        <label class="ias-gc-label">표정 세트 (한 줄에 감정 1개, 줄 순서 = 감정번호)</label>
        <textarea class="ias-input ias-gc-expr" rows="4" placeholder="예:&#10;1 hooded eyes&#10;2 smiling">${escapeHtml(expressions)}</textarea>
        <label class="ias-gc-label">캐릭터 네거티브 (이 캐릭터 Undesired Content)</label>
        <textarea class="ias-input ias-gc-neg" rows="2" placeholder="이 캐릭터의 Undesired Content에 적용 · 비우면 없음">${escapeHtml(negative)}</textarea>
      </div>`;
  }

  function genBgRowHtml(data = {}) {
    const code = data.code != null ? String(data.code) : "";
    const tags = data.tags != null ? String(data.tags) : "";
    const negative = data.negative != null ? String(data.negative) : "";
    return `
      <div class="ias-gen-bg-row">
        <div class="ias-gen-row-head">
          <input class="ias-input ias-gb-code" type="text" maxlength="40" placeholder="코드 (예: h)" value="${escapeAttr(code)}">
          <button class="ias-icon-btn ias-gb-del" type="button" title="이 배경 삭제">${icon("delete", 16)}</button>
        </div>
        <label class="ias-gc-label">배경 태그 (긍정 · 캐릭터 프롬프트에 합쳐짐)</label>
        <textarea class="ias-input ias-gb-tags" rows="2" placeholder="배경 태그">${escapeHtml(tags)}</textarea>
        <label class="ias-gc-label">배경 네거티브 (캐릭터 Undesired Content에 합쳐짐 · 비우면 없음)</label>
        <textarea class="ias-input ias-gb-neg" rows="2" placeholder="이 배경의 네거티브">${escapeHtml(negative)}</textarea>
      </div>`;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  function addGenCharRow(data) {
    if (!ui.genChars) {
      return;
    }
    ui.genChars.insertAdjacentHTML("beforeend", genCharRowHtml(data));
    updateGenPreview();
  }

  function addGenBgRow(data) {
    if (!ui.genBgs) {
      return;
    }
    ui.genBgs.insertAdjacentHTML("beforeend", genBgRowHtml(data));
    updateGenPreview();
  }

  // Raw field values, exactly as typed (for persistence + round-trip).
  function collectGenRaw() {
    const chars = ui.genChars
      ? Array.from(ui.genChars.querySelectorAll(".ias-gen-char-row")).map((row) => ({
          code: row.querySelector(".ias-gc-code")?.value || "",
          appearance: row.querySelector(".ias-gc-appear")?.value || "",
          expressions: row.querySelector(".ias-gc-expr")?.value || "",
          negative: row.querySelector(".ias-gc-neg")?.value || "",
        }))
      : [];
    const bgs = ui.genBgs
      ? Array.from(ui.genBgs.querySelectorAll(".ias-gen-bg-row")).map((row) => ({
          code: row.querySelector(".ias-gb-code")?.value || "",
          tags: row.querySelector(".ias-gb-tags")?.value || "",
          negative: row.querySelector(".ias-gb-neg")?.value || "",
        }))
      : [];
    return {
      base: ui.genBase?.value || "",
      baseNeg: ui.genBaseNeg?.value || "",
      count: ui.genCount?.value || "1",
      split: ui.genSplit?.value || "0",
      chars,
      bgs,
    };
  }

  function genPreviewCount() {
    const raw = collectGenRaw();
    const bgCount = raw.bgs.filter((bg) => bg.code.trim()).length;
    let total = 0;
    for (const ch of raw.chars) {
      if (!ch.code.trim()) {
        continue;
      }
      total += parseExpressionSet(ch.expressions).length * bgCount;
    }
    return total;
  }

  function updateGenPreview() {
    if (ui.genPreview) {
      ui.genPreview.innerHTML = `총 <strong>${genPreviewCount()}</strong>개 생성됨`;
    }
  }

  // NovelAI separates tags by comma. When appearance / expression / background
  // groups are stacked on separate lines, each group must end with a comma or
  // NAI fuses the boundary tags (e.g. "long hair" + "smiling" -> "long hair
  // smiling"). Force exactly one trailing comma per non-empty group.
  function ensureTrailingComma(value) {
    const t = String(value == null ? "" : value).trim();
    if (!t) {
      return "";
    }
    return /,\s*$/.test(t) ? t.replace(/\s*$/, "") : `${t},`;
  }

  // Expand the raw input into queue items (character × background × expression).
  function buildGenItems() {
    const raw = collectGenRaw();
    const base = raw.base;
    const baseNeg = String(raw.baseNeg || "").trim();
    const count = Math.max(1, Number.parseInt(raw.count, 10) || 1);
    const items = [];
    for (const ch of raw.chars) {
      const charCode = ch.code.trim();
      if (!charCode) {
        continue;
      }
      const expressions = parseExpressionSet(ch.expressions);
      const appearance = String(ch.appearance || "").trim();
      const negative = String(ch.negative || "").trim();
      for (const bg of raw.bgs) {
        const bgCode = bg.code.trim();
        if (!bgCode) {
          continue;
        }
        const bgTags = String(bg.tags || "").trim();
        const bgNeg = String(bg.negative || "").trim();
        expressions.forEach((expr, index) => {
          const emotionNumber = index + 1;
          const characterPrompt = [appearance, expr.trim(), bgTags]
            .map(ensureTrailingComma)
            .filter(Boolean)
            .join("\n");
          const combinedNegative = [negative, bgNeg].filter(Boolean).join(", ");
          items.push(Store.createItem({
            title: `${charCode}_${bgCode}_${emotionNumber}`,
            basePrompt: base,
            baseNegativePrompt: baseNeg,
            characterPrompt,
            negativePrompt: combinedNegative,
            count,
          }));
        });
      }
    }
    return { items, base };
  }

  function genBaseOptions(base) {
    return { loop: false, useGlobalBase: true, globalBase: base, namePattern: "" };
  }

  async function genAppendToQueue() {
    const { items, base } = buildGenItems();
    if (!items.length) {
      setStatus("생성할 조합이 없습니다. 캐릭터/배경 코드와 표정을 확인하세요.", "warn");
      return;
    }
    await loadQueueState();
    queueState.items.push(...items);
    // Generated items each carry their own basePrompt, so an existing queue's
    // base settings are left untouched; only fill globalBase if none is set yet.
    if (!String(queueState.options.globalBase || "").trim()) {
      queueState.options.globalBase = base;
    }
    selectedQueueId = items[0].id;
    await persistQueueState();
    setActiveTab("queue");
    setStatus(`조합 ${items.length}개를 현재 큐에 추가했습니다. (총 ${queueState.items.length}개)`, "ok");
  }

  async function genReplaceQueue() {
    const { items, base } = buildGenItems();
    if (!items.length) {
      setStatus("생성할 조합이 없습니다. 캐릭터/배경 코드와 표정을 확인하세요.", "warn");
      return;
    }
    await loadQueueState();
    if (queueState.items.length && !window.confirm(`현재 큐의 ${queueState.items.length}개 항목을 지우고 새 조합 ${items.length}개로 교체할까요?`)) {
      return;
    }
    queueState = Store.normalizeState({ items, options: genBaseOptions(base) });
    selectedQueueId = items[0].id;
    await persistQueueState();
    setActiveTab("queue");
    setStatus(`새 큐로 교체했습니다. (${items.length}개)`, "ok");
  }

  function genExportJson() {
    const { items, base } = buildGenItems();
    if (!items.length) {
      setStatus("생성할 조합이 없습니다. 캐릭터/배경 코드와 표정을 확인하세요.", "warn");
      return;
    }
    const splitValue = Number.parseInt(ui.genSplit?.value, 10);
    const perFile = Number.isFinite(splitValue) && splitValue > 0 ? splitValue : 0;
    const options = genBaseOptions(base);
    const chunks = [];
    if (perFile > 0) {
      for (let i = 0; i < items.length; i += perFile) {
        chunks.push(items.slice(i, i + perFile));
      }
    } else {
      chunks.push(items);
    }
    const stamp = Date.now();
    chunks.forEach((chunk, index) => {
      const envelope = Store.createExportEnvelope({ items: chunk, options }, {});
      const suffix = chunks.length > 1 ? `-${String(index + 1).padStart(2, "0")}` : "";
      downloadJson(envelope, `nai-queue-combo-${stamp}${suffix}.json`);
    });
    setStatus(`JSON ${chunks.length}개 파일로 내보냈습니다. (총 ${items.length}개 항목)`, "ok");
  }

  function scheduleGenSave() {
    if (genSaveTimer) {
      clearTimeout(genSaveTimer);
    }
    genSaveTimer = setTimeout(() => {
      genSaveTimer = null;
      void storageSet("local", { [GENERATOR_STORAGE_KEY]: collectGenRaw() });
    }, 400);
  }

  async function loadGeneratorState() {
    let stored = {};
    try {
      const result = await storageGet("local", [GENERATOR_STORAGE_KEY]);
      stored = result[GENERATOR_STORAGE_KEY] || {};
    } catch (error) {
      void error;
    }
    if (ui.genBase) {
      ui.genBase.value = stored.base || "";
    }
    if (ui.genBaseNeg) {
      ui.genBaseNeg.value = stored.baseNeg || "";
    }
    if (ui.genCount) {
      ui.genCount.value = stored.count || "1";
    }
    if (ui.genSplit) {
      ui.genSplit.value = stored.split || "0";
    }
    if (ui.genChars) {
      ui.genChars.innerHTML = "";
      const chars = Array.isArray(stored.chars) && stored.chars.length ? stored.chars : [{}];
      chars.forEach((data) => ui.genChars.insertAdjacentHTML("beforeend", genCharRowHtml(data)));
    }
    if (ui.genBgs) {
      ui.genBgs.innerHTML = "";
      const bgs = Array.isArray(stored.bgs) && stored.bgs.length ? stored.bgs : [{}];
      bgs.forEach((data) => ui.genBgs.insertAdjacentHTML("beforeend", genBgRowHtml(data)));
    }
    updateGenPreview();
  }

  function handleGenInput() {
    updateGenPreview();
    scheduleGenSave();
  }

  function handleGenClick(event) {
    const charDel = event.target.closest(".ias-gc-del");
    if (charDel) {
      const row = charDel.closest(".ias-gen-char-row");
      if (row) {
        row.remove();
        updateGenPreview();
        scheduleGenSave();
      }
      return;
    }
    const bgDel = event.target.closest(".ias-gb-del");
    if (bgDel) {
      const row = bgDel.closest(".ias-gen-bg-row");
      if (row) {
        row.remove();
        updateGenPreview();
        scheduleGenSave();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // prompt memos
  // ---------------------------------------------------------------------------
  const MEMO_FIELDS = [
    { key: "basePrompt", label: "베이스 프롬프트", input: "memoBaseInput", check: "memoBaseCheck", auto: "autoBaseInput" },
    { key: "baseNegativePrompt", label: "베이스 네거티브", input: "memoBaseNegInput", check: "memoBaseNegCheck", auto: "autoBaseNegInput" },
    { key: "characterPrompt", label: "캐릭터 태그", input: "memoCharInput", check: "memoCharCheck", auto: "autoCharInput" },
    { key: "characterNegativePrompt", label: "캐릭터 네거티브", input: "memoCharNegInput", check: "memoCharNegCheck", auto: "autoCharNegInput" },
  ];

  function createMemoId() {
    try {
      if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
      }
    } catch (error) {
      void error;
    }
    return `memo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function normalizeMemoItem(raw, index = 0) {
    const source = raw && typeof raw === "object" ? raw : {};
    const rawValues = source.values && typeof source.values === "object" ? source.values : {};
    const values = {};
    for (const field of MEMO_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(rawValues, field.key)) {
        values[field.key] = String(rawValues[field.key] == null ? "" : rawValues[field.key]);
      }
    }
    return {
      id: String(source.id || createMemoId()),
      name: String(source.name || `메모 ${index + 1}`).trim().slice(0, 80) || `메모 ${index + 1}`,
      values,
      createdAt: Number(source.createdAt) || Date.now(),
      updatedAt: Number(source.updatedAt) || Number(source.createdAt) || Date.now(),
    };
  }

  function normalizeMemoState(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const items = Array.isArray(source.items)
      ? source.items.map((item, index) => normalizeMemoItem(item, index)).filter((item) => Object.keys(item.values).length)
      : [];
    return { schemaVersion: 1, items };
  }

  async function loadMemoState() {
    try {
      const result = await storageGet("local", [MEMO_STORAGE_KEY]);
      memoState = normalizeMemoState(result[MEMO_STORAGE_KEY]);
    } catch (error) {
      memoState = { schemaVersion: 1, items: [] };
    }
    renderMemoList();
  }

  async function persistMemoState() {
    memoState = normalizeMemoState(memoState);
    await storageSet("local", { [MEMO_STORAGE_KEY]: memoState });
    renderMemoList();
  }

  function createMemoExportEnvelope() {
    return {
      app: "NAI-Auto-Saver",
      memoSchemaVersion: 1,
      exportedAt: new Date().toISOString(),
      memos: normalizeMemoState(memoState),
    };
  }

  function parseMemoImportText(text) {
    let parsed;
    try {
      parsed = JSON.parse(String(text == null ? "" : text));
    } catch (error) {
      return { ok: false, error: "메모 JSON 형식이 올바르지 않습니다." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "메모 파일 구조를 확인할 수 없습니다." };
    }
    if (parsed.app && parsed.app !== "NAI-Auto-Saver") {
      return { ok: false, error: "NAI AutoSaver 메모 파일이 아닙니다." };
    }
    const rawState = parsed.memos && typeof parsed.memos === "object"
      ? parsed.memos
      : parsed.memoState && typeof parsed.memoState === "object"
        ? parsed.memoState
        : parsed;
    if (!Array.isArray(rawState.items)) {
      return { ok: false, error: "파일에 메모 목록이 없습니다." };
    }
    const state = normalizeMemoState(rawState);
    if (rawState.items.length > 0 && state.items.length === 0) {
      return { ok: false, error: "가져올 수 있는 메모가 없습니다." };
    }
    return { ok: true, state };
  }

  function exportMemos() {
    if (!memoState.items.length) {
      setStatus("내보낼 메모가 없습니다.", "warn");
      return;
    }
    downloadJson(createMemoExportEnvelope(), `nai-auto-saver-memos-${Date.now()}.json`);
    setStatus(`메모 ${memoState.items.length}개를 파일로 내보냈습니다.`, "ok");
  }

  async function importMemosFromFile(file) {
    if (!file) {
      return;
    }
    try {
      const parsed = parseMemoImportText(await file.text());
      if (!parsed.ok) {
        setStatus(parsed.error, "warn");
        return;
      }
      const previousIds = new Set(memoState.items.map((item) => item.id));
      const importedIds = new Set(parsed.state.items.map((item) => item.id));
      const addedCount = parsed.state.items.filter((item) => !previousIds.has(item.id)).length;
      const updatedCount = parsed.state.items.length - addedCount;
      memoState = normalizeMemoState({
        schemaVersion: 1,
        items: [
          ...parsed.state.items,
          ...memoState.items.filter((item) => !importedIds.has(item.id)),
        ],
      });
      resetMemoDraft();
      await persistMemoState();
      const detail = [
        addedCount ? `추가 ${addedCount}개` : "",
        updatedCount ? `갱신 ${updatedCount}개` : "",
      ].filter(Boolean).join(", ");
      setStatus(`메모를 가져왔습니다. (${detail || "변경 없음"}, 전체 ${memoState.items.length}개)`, "ok");
    } catch (error) {
      setStatus("메모 파일을 가져오지 못했습니다.", "warn");
    }
  }

  function memoFieldNames(item) {
    return MEMO_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(item.values || {}, field.key))
      .map((field) => field.label);
  }

  function memoPreview(item) {
    for (const field of MEMO_FIELDS) {
      const value = item.values?.[field.key];
      if (typeof value === "string" && value.trim()) {
        return value.trim().replace(/\s+/g, " ").slice(0, 120);
      }
    }
    return "내용 없음";
  }

  function resetMemoDraft({ keepValues = false } = {}) {
    selectedMemoId = null;
    if (ui.memoNameInput) {
      ui.memoNameInput.value = "";
    }
    for (const field of MEMO_FIELDS) {
      const checkbox = ui[field.check];
      const input = ui[field.input];
      if (checkbox) {
        checkbox.checked = true;
      }
      if (input && !keepValues) {
        input.value = "";
      }
    }
    renderMemoEditorState();
  }

  function renderMemoEditorState() {
    if (ui.memoSaveButton) {
      const label = ui.memoSaveButton.querySelector("span");
      if (label) {
        label.textContent = selectedMemoId ? "메모 수정 저장" : "새 메모 저장";
      }
    }
    if (ui.memoCancelEditButton) {
      ui.memoCancelEditButton.hidden = !selectedMemoId;
    }
    for (const field of MEMO_FIELDS) {
      const checkbox = ui[field.check];
      const input = ui[field.input];
      if (input && checkbox) {
        input.disabled = !checkbox.checked;
      }
    }
  }

  function collectMemoDraft() {
    const values = {};
    const emptySelected = [];
    for (const field of MEMO_FIELDS) {
      const checkbox = ui[field.check];
      const input = ui[field.input];
      if (!checkbox?.checked) {
        continue;
      }
      const value = input?.value || "";
      if (!value.trim()) {
        emptySelected.push(field.label);
      } else {
        values[field.key] = value;
      }
    }
    return {
      name: (ui.memoNameInput?.value || "").trim(),
      values,
      emptySelected,
      selectedCount: MEMO_FIELDS.filter((field) => ui[field.check]?.checked).length,
    };
  }

  let memoSaveInFlight = false;

  async function handleMemoSavePress(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (memoSaveInFlight) {
      return;
    }
    memoSaveInFlight = true;
    const button = ui.memoSaveButton;
    const scroll = button?.closest('.ias-scroll') || null;
    const previousScrollTop = scroll?.scrollTop || 0;
    const active = panelShadow?.activeElement;
    if (active instanceof HTMLElement && active !== button) {
      active.blur();
    }
    // Let IME composition / textarea input settle before reading the draft.
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    if (button) {
      button.disabled = true;
    }
    try {
      await savePromptMemo();
    } finally {
      if (button) {
        button.disabled = false;
      }
      requestAnimationFrame(() => {
        if (scroll) {
          scroll.scrollTop = Math.min(previousScrollTop, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
        }
      });
      memoSaveInFlight = false;
    }
  }

  async function savePromptMemo() {
    const draft = collectMemoDraft();
    if (!draft.selectedCount) {
      setStatus("메모할 항목을 1개 이상 선택해 주세요.", "warn");
      return;
    }
    if (draft.emptySelected.length) {
      setStatus(`선택한 항목의 내용이 비어 있습니다: ${draft.emptySelected.join(", ")}`, "warn");
      return;
    }
    const now = Date.now();
    const existingIndex = memoState.items.findIndex((item) => item.id === selectedMemoId);
    if (existingIndex >= 0) {
      const existing = memoState.items[existingIndex];
      memoState.items[existingIndex] = normalizeMemoItem({
        ...existing,
        name: draft.name || existing.name,
        values: draft.values,
        updatedAt: now,
      }, existingIndex);
      await persistMemoState();
      setStatus(`메모 “${memoState.items[existingIndex].name}”을 수정했습니다.`, "ok");
    } else {
      const item = normalizeMemoItem({
        id: createMemoId(),
        name: draft.name || `메모 ${memoState.items.length + 1}`,
        values: draft.values,
        createdAt: now,
        updatedAt: now,
      }, memoState.items.length);
      memoState.items.unshift(item);
      await persistMemoState();
      setStatus(`메모 “${item.name}”을 저장했습니다.`, "ok");
    }
    resetMemoDraft();
  }

  function editPromptMemo(id) {
    const item = memoState.items.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    selectedMemoId = item.id;
    if (ui.memoNameInput) {
      ui.memoNameInput.value = item.name;
    }
    for (const field of MEMO_FIELDS) {
      const included = Object.prototype.hasOwnProperty.call(item.values, field.key);
      if (ui[field.check]) {
        ui[field.check].checked = included;
      }
      if (ui[field.input]) {
        ui[field.input].value = included ? item.values[field.key] : "";
      }
    }
    renderMemoEditorState();
    ui.memoNameInput?.focus();
  }

  async function deletePromptMemo(id) {
    const item = memoState.items.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    if (!window.confirm(`“${item.name}” 메모를 삭제할까요?`)) {
      return;
    }
    memoState.items = memoState.items.filter((entry) => entry.id !== id);
    if (selectedMemoId === id) {
      resetMemoDraft();
    }
    await persistMemoState();
    setStatus("메모를 삭제했습니다.", "ok");
  }

  function copyAutoValuesToMemo() {
    const pairs = [
      ["memoBaseInput", "autoBaseInput"],
      ["memoBaseNegInput", "autoBaseNegInput"],
      ["memoCharInput", "autoCharInput"],
      ["memoCharNegInput", "autoCharNegInput"],
    ];
    for (const [memoKey, autoKey] of pairs) {
      if (ui[memoKey]) {
        ui[memoKey].value = ui[autoKey]?.value || "";
      }
    }
    for (const field of MEMO_FIELDS) {
      if (ui[field.check]) {
        ui[field.check].checked = true;
      }
    }
    renderMemoEditorState();
    setStatus("자동생성 탭의 4개 값을 메모 편집기에 가져왔습니다.", "ok");
  }

  async function captureNovelAiValuesToMemo() {
    if (ui.memoCaptureButton) {
      ui.memoCaptureButton.disabled = true;
    }
    try {
      const values = {
        basePrompt: await readCurrentNaiPrompt(),
        baseNegativePrompt: await readCurrentNaiNegativePrompt(),
        characterPrompt: await readCurrentNaiCharacterPrompt(),
        characterNegativePrompt: await readCurrentNaiCharacterNegative(),
      };
      for (const field of MEMO_FIELDS) {
        if (ui[field.input]) {
          ui[field.input].value = values[field.key] || "";
        }
        if (ui[field.check]) {
          ui[field.check].checked = true;
        }
      }
      renderMemoEditorState();
      setStatus("NovelAI의 현재 프롬프트 4종을 읽어왔습니다.", "ok");
    } catch (error) {
      setStatus("NovelAI의 현재 프롬프트를 읽지 못했습니다.", "warn");
    } finally {
      if (ui.memoCaptureButton) {
        ui.memoCaptureButton.disabled = false;
      }
    }
  }

  function applyMemoToAuto(id) {
    const item = memoState.items.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    for (const field of MEMO_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(item.values, field.key)) {
        continue;
      }
      const target = ui[field.auto];
      if (target) {
        target.value = item.values[field.key];
      }
    }
    saveSingleSettings();
    setActiveTab("auto");
    setStatus(`“${item.name}” 메모를 자동생성 입력칸에 불러왔습니다.`, "ok");
  }

  async function addMemoToQueue(id) {
    const item = memoState.items.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    if (queueRun.active) {
      setStatus("대기열 실행 중에는 메모를 추가할 수 없습니다.", "warn");
      return;
    }
    await loadQueueState();
    const values = item.values || {};
    const count = Math.max(1, Number.parseInt(ui.countInput?.value, 10) || 1);
    const newItem = Store.createItem({
      title: item.name,
      basePrompt: Object.prototype.hasOwnProperty.call(values, "basePrompt") ? values.basePrompt : "",
      baseNegativePrompt: Object.prototype.hasOwnProperty.call(values, "baseNegativePrompt") ? values.baseNegativePrompt : "",
      characterPrompt: Object.prototype.hasOwnProperty.call(values, "characterPrompt") ? values.characterPrompt : "",
      negativePrompt: Object.prototype.hasOwnProperty.call(values, "characterNegativePrompt") ? values.characterNegativePrompt : "",
      count,
    });
    queueState.items.push(newItem);
    selectedQueueId = newItem.id;
    await persistQueueState();
    setStatus(`메모 “${item.name}”을 대기열에 추가했습니다. (${queueState.items.length}개)`, "ok");
  }

  async function applyMemoDirectly(id) {
    const item = memoState.items.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    const values = item.values || {};
    const promptResult = await applyStructuredPrompt(
      Object.prototype.hasOwnProperty.call(values, "basePrompt") ? values.basePrompt : null,
      Object.prototype.hasOwnProperty.call(values, "characterPrompt") ? values.characterPrompt : null
    );
    if (!promptResult.ok) {
      setStatus(promptResult.error || "메모 프롬프트를 NovelAI에 적용하지 못했습니다.", "warn");
      return;
    }
    if (Object.prototype.hasOwnProperty.call(values, "baseNegativePrompt")) {
      const result = await applyBaseNegativeToNovelAi(values.baseNegativePrompt);
      if (!result.ok) {
        return;
      }
    }
    if (Object.prototype.hasOwnProperty.call(values, "characterNegativePrompt")) {
      const result = await applyCharacterNegativesToNovelAi(values.characterNegativePrompt);
      if (!result.ok) {
        return;
      }
    }
    setStatus(`“${item.name}” 메모를 NovelAI에 직접 적용했습니다.`, "ok");
  }

  function renderMemoList() {
    if (!ui.memoList) {
      return;
    }
    ui.memoList.innerHTML = "";
    if (!memoState.items.length) {
      const empty = document.createElement("div");
      empty.className = "ias-empty";
      empty.textContent = "저장된 메모가 없습니다.";
      ui.memoList.append(empty);
      return;
    }
    memoState.items.forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "ias-memo-card";
      card.dataset.id = item.id;

      const top = document.createElement("div");
      top.className = "ias-memo-card-top";
      const order = document.createElement("span");
      order.className = "ias-memo-order";
      order.textContent = String(index + 1);
      const title = document.createElement("strong");
      title.className = "ias-memo-title";
      title.textContent = item.name;
      const meta = document.createElement("span");
      meta.className = "ias-memo-count";
      meta.textContent = `${memoFieldNames(item).length}/4`;
      top.append(order, title, meta);

      const preview = document.createElement("div");
      preview.className = "ias-memo-preview";
      preview.textContent = memoPreview(item);

      const chips = document.createElement("div");
      chips.className = "ias-memo-chips";
      for (const name of memoFieldNames(item)) {
        const chip = document.createElement("span");
        chip.textContent = name;
        chips.append(chip);
      }

      const actions = document.createElement("div");
      actions.className = "ias-memo-card-actions";

      const queueButton = document.createElement("button");
      queueButton.type = "button";
      queueButton.className = "ias-memo-queue";
      queueButton.dataset.action = "queue";
      queueButton.innerHTML = `${icon("playlist_add", 17)}<span>대기열에 추가</span>`;

      const moreButton = document.createElement("button");
      moreButton.type = "button";
      moreButton.className = "ias-memo-more";
      moreButton.dataset.action = "menu";
      moreButton.setAttribute("aria-label", `${item.name} 메모 메뉴`);
      moreButton.setAttribute("aria-haspopup", "menu");
      moreButton.setAttribute("aria-expanded", "false");
      moreButton.innerHTML = '<span class="ias-more-dots" aria-hidden="true"></span>';

      const menu = document.createElement("div");
      menu.className = "ias-memo-menu";
      menu.setAttribute("role", "menu");
      menu.hidden = true;
      const menuItems = [
        { action: "export", label: "내보내기", iconName: "download" },
        { action: "import", label: "가져오기", iconName: "upload" },
        { separator: true },
        { action: "load", label: "자동생성에 불러오기", iconName: "content_copy" },
        { action: "apply", label: "NovelAI에 바로 적용", iconName: "bolt" },
        { separator: true },
        { action: "edit", label: "메모 수정", iconName: "tune" },
        { action: "delete", label: "메모 삭제", iconName: "delete", danger: true },
      ];
      for (const config of menuItems) {
        if (config.separator) {
          const separator = document.createElement("div");
          separator.className = "ias-memo-menu-separator";
          separator.setAttribute("role", "separator");
          menu.append(separator);
          continue;
        }
        const menuButton = document.createElement("button");
        menuButton.type = "button";
        menuButton.className = "ias-memo-menu-item";
        menuButton.dataset.action = config.action;
        menuButton.setAttribute("role", "menuitem");
        if (config.danger) {
          menuButton.dataset.danger = "true";
        }
        menuButton.innerHTML = `${icon(config.iconName, 17)}<span>${config.label}</span>`;
        menu.append(menuButton);
      }

      actions.append(queueButton, moreButton, menu);
      card.append(top, preview, chips, actions);
      ui.memoList.append(card);
    });
  }

  function runMemoAction(id, action) {
    if (action === "queue") {
      void addMemoToQueue(id);
    } else if (action === "export") {
      exportMemos();
    } else if (action === "import") {
      ui.memoImportFile?.click();
    } else if (action === "load") {
      applyMemoToAuto(id);
    } else if (action === "apply") {
      void applyMemoDirectly(id);
    } else if (action === "edit") {
      editPromptMemo(id);
    } else if (action === "delete") {
      void deletePromptMemo(id);
    }
  }

  function closeMemoMenus(exceptCard = null) {
    if (!ui.memoList) {
      return;
    }
    ui.memoList.querySelectorAll(".ias-memo-card").forEach((card) => {
      if (exceptCard && card === exceptCard) {
        return;
      }
      const menu = card.querySelector(".ias-memo-menu");
      const toggle = card.querySelector(".ias-memo-more");
      if (menu) {
        menu.hidden = true;
        delete menu.dataset.placement;
      }
      toggle?.setAttribute("aria-expanded", "false");
      delete card.dataset.menuOpen;
    });
  }

  function openMemoMenu(card, toggle, menu) {
    closeMemoMenus(card);
    menu.hidden = false;
    card.dataset.menuOpen = "true";
    toggle.setAttribute("aria-expanded", "true");

    const scroll = card.closest(".ias-scroll");
    const viewport = scroll?.getBoundingClientRect() || {
      top: 0,
      bottom: window.innerHeight,
    };
    const triggerRect = toggle.getBoundingClientRect();
    const menuHeight = menu.offsetHeight || 190;
    const above = triggerRect.top - viewport.top;
    const below = viewport.bottom - triggerRect.bottom;
    menu.dataset.placement = below >= menuHeight + 12 || below >= above ? "below" : "above";
  }

  function handleMemoListClick(event) {
    const button = event.target.closest("button[data-action]");
    const card = event.target.closest(".ias-memo-card");
    if (!button || !card?.dataset.id) {
      return;
    }
    const action = button.dataset.action;
    if (action === "menu") {
      const menu = card.querySelector(".ias-memo-menu");
      if (!menu) {
        return;
      }
      const isOpen = !menu.hidden;
      if (isOpen) {
        closeMemoMenus();
      } else {
        openMemoMenu(card, button, menu);
      }
      return;
    }
    closeMemoMenus();
    runMemoAction(card.dataset.id, action);
  }

  // ---------------------------------------------------------------------------
  // settings
  // ---------------------------------------------------------------------------
  async function loadSettings() {
    const settings = await storageGet("sync", SYNC_KEYS);
    const {
      intervalTime = 3,
      gcount = "",
      singleSaveName = "",
      saveFolder = "NovelAI",
      autoBase = "",
      autoBaseNeg = "",
      autoChar = "",
      autoCharNeg = "",
      autoSaveEnabled = true,
      autoCompletionNotificationEnabled = true,
    } = settings;
    if (ui.intervalInput) {
      ui.intervalInput.value = String(intervalTime);
    }
    if (ui.countInput) {
      ui.countInput.value = gcount === 0 || gcount === "" ? "" : String(gcount);
    }
    if (ui.saveNameInput) {
      ui.saveNameInput.value = singleSaveName;
    }
    if (ui.autoBaseInput) {
      ui.autoBaseInput.value = autoBase;
    }
    if (ui.autoBaseNegInput) {
      ui.autoBaseNegInput.value = autoBaseNeg;
    }
    if (ui.autoCharInput) {
      ui.autoCharInput.value = autoChar;
    }
    if (ui.autoCharNegInput) {
      ui.autoCharNegInput.value = autoCharNeg;
    }
    if (ui.folderInput) {
      ui.folderInput.value = normalizeFolderInput(saveFolder);
    }
    if (ui.autoSaveToggle) {
      ui.autoSaveToggle.checked = autoSaveEnabled !== false;
    }
    if (ui.notifyToggle) {
      ui.notifyToggle.checked = autoCompletionNotificationEnabled !== false;
    }
    // ensure default ON is persisted the first time
    if (settings.autoSaveEnabled === undefined) {
      await storageSet("sync", { autoSaveEnabled: true });
    }
  }

  function saveSingleSettings() {
    const intervalTime = Math.max(0.1, Number.parseFloat(ui.intervalInput?.value) || 3);
    const gcountRaw = Number.parseInt(ui.countInput?.value, 10);
    const gcount = Number.isFinite(gcountRaw) && gcountRaw > 0 ? gcountRaw : "";
    void storageSet("sync", {
      intervalTime,
      gcount: gcount === "" ? "" : gcount,
      singleSaveName: (ui.saveNameInput?.value || "").trim(),
      saveFolder: (ui.folderInput?.value || "").trim(),
      autoBase: ui.autoBaseInput?.value || "",
      autoBaseNeg: ui.autoBaseNegInput?.value || "",
      autoChar: ui.autoCharInput?.value || "",
      autoCharNeg: ui.autoCharNegInput?.value || "",
    });
  }

  function savePreferences() {
    void storageSet("sync", {
      autoSaveEnabled: Boolean(ui.autoSaveToggle?.checked),
      autoCompletionNotificationEnabled: Boolean(ui.notifyToggle?.checked),
    });
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // ETA (estimated time)
  // ---------------------------------------------------------------------------
  function formatEta(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
      return "";
    }
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
    }
    if (m > 0) {
      return s > 0 ? `${m}분 ${s}초` : `${m}분`;
    }
    return `${s}초`;
  }

  // Estimated wall-clock finish time, e.g. "오후 3:42". Formatted manually so
  // it doesn't depend on the JS engine's locale (ICU) data.
  function formatClock(targetMs) {
    const date = new Date(targetMs);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    let hour = date.getHours();
    const minute = String(date.getMinutes()).padStart(2, "0");
    const period = hour < 12 ? "오전" : "오후";
    hour %= 12;
    if (hour === 0) {
      hour = 12;
    }
    return `${period} ${hour}:${minute}`;
  }

  function avgImageMs() {
    if (!etaTracker.samples.length) {
      return null;
    }
    const sum = etaTracker.samples.reduce((a, b) => a + b, 0);
    return sum / etaTracker.samples.length;
  }

  function resetEtaTracker() {
    etaTracker.samples = [];
    etaTracker.lastCompleteTs = 0;
  }

  // Call once per completed image. The gap between consecutive completions is
  // the true per-image wall time (generation + interval), so the first
  // completion only seeds lastCompleteTs and yields no sample.
  function recordImageCompletion() {
    const now = Date.now();
    if (etaTracker.lastCompleteTs) {
      const d = now - etaTracker.lastCompleteTs;
      // Ignore implausible gaps (paused tab, manual stall): 0 < d < 10 min.
      if (d > 0 && d < 10 * 60 * 1000) {
        etaTracker.samples.push(d);
        if (etaTracker.samples.length > etaTracker.maxSamples) {
          etaTracker.samples.shift();
        }
        seedImageMs = avgImageMs();
        void storageSet("local", { [ETA_SEED_KEY]: seedImageMs });
      }
    }
    etaTracker.lastCompleteTs = now;
  }

  // Images still to generate in the current run. null = unlimited (no ETA).
  function remainingImages() {
    if (queueRun.active) {
      const items = queueRun.items;
      let remain = 0;
      for (let i = queueRun.index + 1; i < items.length; i += 1) {
        remain += items[i]?.count || 0;
      }
      const current = items[queueRun.index];
      const currentTarget = current ? current.count || 0 : 0;
      remain += Math.max(0, currentTarget - autoRun.count);
      return remain;
    }
    if (autoRun.active && autoRun.target > 0) {
      return Math.max(0, autoRun.target - autoRun.count);
    }
    return null;
  }

  function progressLine() {
    if (queueRun.active) {
      const item = queueRun.items[queueRun.index];
      const title = item ? item.title : "";
      const target = item ? item.count || 0 : 0;
      const itemPct = currentItemPercent();
      const overall = overallPercent();
      const itemPart = target > 0
        ? `항목 ${autoRun.count}/${target}장 (${itemPct}%)`
        : `항목 ${autoRun.count}장`;
      const overallPart = overall != null ? ` · 전체 ${overall}%` : "";
      return `대기열 ${queueRun.index + 1}/${queueRun.items.length} · ${title} · ${itemPart}${overallPart}`;
    }
    const target = autoRun.target || 0;
    if (target > 0) {
      return `자동 생성 진행 중: ${autoRun.count}/${target}장 (${currentItemPercent()}%)`;
    }
    return `자동 생성 진행 중: ${autoRun.count}장`;
  }

  function queueTotalImages() {
    return queueRun.items.reduce((sum, item) => sum + (item.count || 0), 0);
  }

  // Whole-queue progress for the current pass (loop resets each cycle).
  function overallPercent() {
    if (!queueRun.active) {
      return null;
    }
    const total = queueTotalImages();
    if (total <= 0) {
      return null;
    }
    const done = queueRun.totalGenerated + autoRun.count;
    return Math.min(100, Math.round((done / total) * 100));
  }

  // Progress within the item currently generating.
  function currentItemPercent() {
    let target = 0;
    if (queueRun.active) {
      const item = queueRun.items[queueRun.index];
      target = item ? item.count || 0 : 0;
    } else if (autoRun.active) {
      target = autoRun.target || 0;
    }
    if (target <= 0) {
      return null;
    }
    return Math.min(100, Math.round((autoRun.count / target) * 100));
  }

  function liveEtaSuffix() {
    const remain = remainingImages();
    if (remain == null) {
      return "";
    }
    const per = avgImageMs() || seedImageMs;
    if (!per) {
      return ` · 남은 ${remain}장 · 남은 시간 측정 중…`;
    }
    const remainMs = remain * per;
    const eta = formatEta(remainMs);
    const finish = formatClock(Date.now() + remainMs);
    const loopNote = queueRun.active && queueRun.loop ? " (이번 회차)" : "";
    const finishNote = finish ? ` · 완료 예정 ${finish}` : "";
    return ` · 남은 ${remain}장 · 남은 시간 약 ${eta}${finishNote}${loopNote}`;
  }

  // Pre-run text for the queue bar, including a measured-speed estimate.
  function queueCountText() {
    const n = queueState.items.length;
    if (!n) {
      return "비어 있음";
    }
    const total = queueState.items.reduce((sum, item) => sum + (item.count || 0), 0);
    let text = `${n}개 · 총 ${total}장`;
    if (seedImageMs && total > 0) {
      text += ` · 예상 소요 ${formatEta(total * seedImageMs)}`;
      if (queueState.options.loop) {
        text += "/회";
      }
    }
    return text;
  }

  async function loadEtaSeed() {
    try {
      const stored = await storageGet("local", [ETA_SEED_KEY]);
      const value = Number.parseFloat(stored?.[ETA_SEED_KEY]);
      if (Number.isFinite(value) && value > 0) {
        seedImageMs = value;
      }
    } catch (error) {
      void error;
    }
  }

  function setStatus(message, tone = "neutral") {
    if (!ui.status) {
      return;
    }
    ui.status.textContent = message || "";
    ui.status.dataset.tone = tone;
    if (statusTimer) {
      clearTimeout(statusTimer);
    }
    if (message && tone === "ok") {
      statusTimer = setTimeout(() => {
        if (ui.status) {
          ui.status.dataset.tone = "neutral";
        }
      }, 4000);
    }
  }

  function renderControls() {
    const running = autoRun.active || queueRun.active;
    const completed = Math.max(0, Number.parseInt(autoRun.completedCount, 10) || 0);
    const targetLabel = autoRun.target > 0 ? String(autoRun.target) : "∞";

    if (ui.autoButton) {
      const label = ui.autoButton.querySelector("span");
      if (label) {
        label.textContent = autoRun.active && !queueRun.active ? "자동 생성 중지" : "자동 생성 시작";
      }
      ui.autoButton.dataset.active = autoRun.active && !queueRun.active ? "true" : "false";
      ui.autoButton.disabled = queueRun.active;
    }
    if (ui.queueRunButton) {
      const label = ui.queueRunButton.querySelector("span");
      if (label) {
        label.textContent = queueRun.active ? "대기열 중지" : "대기열 실행";
      }
      ui.queueRunButton.dataset.active = queueRun.active ? "true" : "false";
      ui.queueRunButton.disabled = !queueRun.active && queueState.items.length === 0;
    }
    if (ui.queueAddButton) {
      ui.queueAddButton.disabled = running;
    }
    if (ui.queueClearButton) {
      ui.queueClearButton.disabled = running || queueState.items.length === 0;
    }
    if (ui.fab) {
      ui.fab.dataset.running = running ? "true" : "false";
      ui.fab.innerHTML = icon(running ? "stop" : "play_arrow", 26);
      ui.fab.title = queueRun.active
        ? `대기열 ${queueRun.index + 1}/${queueRun.items.length} · 항목 ${completed}/${targetLabel}${overallPercent() != null ? ` · 전체 ${overallPercent()}%` : ""}`
        : autoRun.active
          ? `생성 중 ${completed}/${targetLabel}`
          : "NAI 자동저장";
    }
  }

  function getSelectedQueueItem() {
    return queueState.items.find((item) => item.id === selectedQueueId) || null;
  }

  function ensureSelection() {
    if (!queueState.items.length) {
      selectedQueueId = null;
      return;
    }
    if (!queueState.items.some((item) => item.id === selectedQueueId)) {
      selectedQueueId = queueState.items[0].id;
    }
  }

  function scheduleQueueSave() {
    if (queueSaveTimer) {
      clearTimeout(queueSaveTimer);
    }
    queueSaveTimer = setTimeout(() => {
      queueSaveTimer = null;
      void storageSet("local", { [QUEUE_STORAGE_KEY]: Store.normalizeState(queueState) });
    }, 300);
  }

  function renderQueue() {
    if (ui.loopToggle) {
      ui.loopToggle.checked = Boolean(queueState.options.loop);
    }
    if (ui.globalBaseToggle) {
      ui.globalBaseToggle.checked = Boolean(queueState.options.useGlobalBase);
    }
    if (ui.globalBaseInput && document.activeElement !== ui.globalBaseInput) {
      ui.globalBaseInput.value = queueState.options.globalBase || "";
    }
    if (ui.globalBaseField) {
      ui.globalBaseField.style.display = queueState.options.useGlobalBase ? "" : "none";
    }
    if (ui.namePatternInput && document.activeElement !== ui.namePatternInput) {
      ui.namePatternInput.value = queueState.options.namePattern || "";
    }
    if (ui.queueCount) {
      ui.queueCount.textContent = queueCountText();
    }
    ensureSelection();
    renderQueueList();
    renderQueueEditor();
  }

  function renderQueueList() {
    if (!ui.queueList) {
      return;
    }
    ui.queueList.innerHTML = "";
    if (!queueState.items.length) {
      const empty = document.createElement("div");
      empty.className = "ias-empty";
      empty.textContent = "‘현재 프롬프트 추가’로 항목을 만든 뒤 아래에서 편집하세요.";
      ui.queueList.append(empty);
      return;
    }
    queueState.items.forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "ias-qcard";
      card.dataset.id = item.id;
      card.draggable = !queueRun.active;
      if (item.id === selectedQueueId) {
        card.dataset.selected = "true";
      }
      if (queueRun.active && index === queueRun.index) {
        card.dataset.running = "true";
      }

      const top = document.createElement("div");
      top.className = "ias-qcard-top";
      const order = document.createElement("span");
      order.className = "ias-qorder";
      order.textContent = String(index + 1);
      const name = document.createElement("span");
      name.className = "ias-qname";
      name.dataset.role = "name";
      name.textContent = (item.title || "").trim() || "(이름 없음)";
      top.append(order, name);

      const preview = document.createElement("div");
      preview.className = "ias-qprev";
      preview.dataset.role = "preview";
      preview.textContent = buildPreview(item);

      const meta = document.createElement("div");
      meta.className = "ias-qmeta";
      meta.dataset.role = "meta";
      meta.textContent = `${item.count}장`;

      const tools = document.createElement("div");
      tools.className = "ias-qcard-tools";
      const buttons = [
        { action: "up", name: "keyboard_arrow_up", disabled: queueRun.active || index === 0 },
        { action: "down", name: "keyboard_arrow_down", disabled: queueRun.active || index === queueState.items.length - 1 },
        { action: "duplicate", name: "content_copy", disabled: queueRun.active },
        { action: "remove", name: "delete", disabled: queueRun.active, danger: true },
      ];
      for (const config of buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = config.action;
        button.innerHTML = icon(config.name, 16);
        button.disabled = config.disabled;
        if (config.danger) {
          button.dataset.danger = "true";
        }
        tools.append(button);
      }

      card.append(top, preview, meta, tools);
      ui.queueList.append(card);
    });

    if (queueRun.active) {
      const runningCard = ui.queueList.querySelector('.ias-qcard[data-running="true"]');
      if (runningCard) {
        runningCard.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    }
  }

  function buildPreview(item) {
    const base = (item.basePrompt || "").trim();
    const chars = (item.characterPrompt || "").trim();
    const combined = chars ? `${base} / ${chars}` : base;
    return combined ? combined.replace(/\s+/g, " ").slice(0, 70) : "(프롬프트 없음 · 현재값 사용)";
  }

  function renderQueueEditor() {
    if (!ui.queueEditor) {
      return;
    }
    ui.queueEditor.innerHTML = "";
    const item = getSelectedQueueItem();
    if (!item) {
      return;
    }

    const disabled = queueRun.active;
    const orderIndex = queueState.items.findIndex((entry) => entry.id === item.id) + 1;

    const header = document.createElement("div");
    header.className = "ias-qeditor-head ias-qeditor-headrow";
    const headTitle = document.createElement("span");
    headTitle.textContent = `항목 ${orderIndex} 편집`;
    header.append(headTitle);
    ui.queueEditor.append(header);

    const topRow = document.createElement("div");
    topRow.className = "ias-qeditor-toprow";

    const nameField = document.createElement("div");
    nameField.className = "ias-field";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "저장 이름";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "ias-input";
    nameInput.value = item.title || "";
    nameInput.placeholder = "예: 1_정면";
    nameInput.maxLength = 80;
    nameInput.dataset.field = "title";
    nameInput.disabled = disabled;
    nameField.append(nameLabel, nameInput);

    const countField = document.createElement("div");
    countField.className = "ias-field ias-qeditor-count";
    const countLabel = document.createElement("label");
    countLabel.textContent = "횟수";
    const countInput = document.createElement("input");
    countInput.type = "number";
    countInput.min = "1";
    countInput.className = "ias-input";
    countInput.value = String(item.count);
    countInput.dataset.field = "count";
    countInput.disabled = disabled;
    countField.append(countLabel, countInput);

    topRow.append(nameField, countField);
    ui.queueEditor.append(topRow);

    const baseField = document.createElement("div");
    baseField.className = "ias-field ias-qeditor-field";
    const baseLabel = document.createElement("label");
    const usingGlobal = Boolean(queueState.options.useGlobalBase) && String(queueState.options.globalBase || "").trim();
    baseLabel.textContent = usingGlobal ? "Base Prompt (공통 Base 사용 중 — 비활성)" : "Base Prompt";
    const baseInput = document.createElement("textarea");
    baseInput.className = "ias-input ias-qbig";
    baseInput.value = item.basePrompt || "";
    baseInput.placeholder = "장면 · 스타일 · 화질 태그 (비우면 현재 NovelAI 베이스 프롬프트 사용)";
    baseInput.rows = editorExpanded ? 8 : 4;
    baseInput.dataset.field = "basePrompt";
    baseInput.disabled = disabled || usingGlobal;
    baseField.append(baseLabel, baseInput);
    ui.queueEditor.append(baseField);

    const baseNegField = document.createElement("div");
    baseNegField.className = "ias-field ias-qeditor-field";
    const baseNegLabel = document.createElement("label");
    baseNegLabel.textContent = "베이스 네거티브 (베이스 Undesired Content)";
    const baseNegInput = document.createElement("textarea");
    baseNegInput.className = "ias-input ias-qbig";
    baseNegInput.value = item.baseNegativePrompt || "";
    baseNegInput.placeholder = "이 항목의 베이스 Undesired Content에 적용 · 비우면 현재 NovelAI 값 그대로";
    baseNegInput.rows = editorExpanded ? 6 : 3;
    baseNegInput.dataset.field = "baseNegativePrompt";
    baseNegInput.disabled = disabled;
    baseNegField.append(baseNegLabel, baseNegInput);
    ui.queueEditor.append(baseNegField);

    const charField = document.createElement("div");
    charField.className = "ias-field ias-qeditor-field";
    const charLabel = document.createElement("label");
    charLabel.textContent = "캐릭터 프롬프트";
    const charInput = document.createElement("textarea");
    charInput.className = "ias-input ias-qbig";
    charInput.value = item.characterPrompt || "";
    charInput.placeholder = "예: girl, black hair, long hair  (여러 명은 ;; 로 구분)";
    charInput.rows = editorExpanded ? 8 : 4;
    charInput.dataset.field = "characterPrompt";
    charInput.disabled = disabled;
    charField.append(charLabel, charInput);
    ui.queueEditor.append(charField);

    const negField = document.createElement("div");
    negField.className = "ias-field ias-qeditor-field";
    const negLabel = document.createElement("label");
    negLabel.textContent = "캐릭터 네거티브 (캐릭터 Undesired Content)";
    const negInput = document.createElement("textarea");
    negInput.className = "ias-input ias-qbig";
    negInput.value = item.negativePrompt || "";
    negInput.placeholder = "이 항목의 캐릭터 Undesired Content에 적용 · 여러 캐릭터는 ;; 로 구분";
    negInput.rows = editorExpanded ? 6 : 3;
    negInput.dataset.field = "negativePrompt";
    negInput.disabled = disabled;
    negField.append(negLabel, negInput);
    ui.queueEditor.append(negField);
  }

  function updateRowDisplay(item) {
    if (!ui.queueList) {
      return;
    }
    const card = ui.queueList.querySelector(`.ias-qcard[data-id="${item.id}"]`);
    if (!card) {
      return;
    }
    const name = card.querySelector('[data-role="name"]');
    const meta = card.querySelector('[data-role="meta"]');
    const preview = card.querySelector('[data-role="preview"]');
    if (name) {
      name.textContent = (item.title || "").trim() || "(이름 없음)";
    }
    if (meta) {
      meta.textContent = `${item.count}장`;
    }
    if (preview) {
      preview.textContent = buildPreview(item);
    }
  }

  function handleQueueListClick(event) {
    const card = event.target.closest(".ias-qcard");
    if (!card) {
      return;
    }
    const id = card.dataset.id;
    if (!id) {
      return;
    }
    const actionButton = event.target.closest("button[data-action]");
    const action = actionButton ? actionButton.dataset.action : null;
    if (action === "up") {
      void moveQueueItem(id, -1);
      return;
    }
    if (action === "down") {
      void moveQueueItem(id, 1);
      return;
    }
    if (action === "duplicate") {
      void duplicateQueueItem(id);
      return;
    }
    if (action === "remove") {
      void removeQueueItem(id);
      return;
    }
    if (selectedQueueId !== id) {
      selectedQueueId = id;
      renderQueueList();
      renderQueueEditor();
    }
  }

  function handleEditorClick(event) {
    const button = event.target.closest('button[data-action="fullscreen"]');
    if (!button) {
      return;
    }
    editorExpanded = !editorExpanded;
    if (ui.shell) {
      ui.shell.dataset.editorExpanded = editorExpanded ? "true" : "false";
    }
    if (editorExpanded) {
      // Let the expand CSS take over; remember the manual size to restore later.
      if (ui.card) {
        ui.card.style.width = "";
        ui.card.style.height = "";
      }
    } else {
      // Restore the user's custom size if they had one.
      applyPanelSize();
    }
    requestAnimationFrame(clampPanelIntoView);
    renderQueueEditor();
  }

  function enableQueueDragSort() {
    const list = ui.queueList;
    if (!list) {
      return;
    }
    let dragId = null;

    list.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".ias-qcard");
      if (!card || queueRun.active) {
        return;
      }
      dragId = card.dataset.id;
      card.dataset.dragging = "true";
      try {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", dragId);
      } catch (error) {
        void error;
      }
    });
    list.addEventListener("dragend", () => {
      const dragged = list.querySelector('.ias-qcard[data-dragging="true"]');
      if (dragged) {
        delete dragged.dataset.dragging;
      }
      list.querySelectorAll('.ias-qcard[data-dropbefore="true"]').forEach((el) => delete el.dataset.dropbefore);
      dragId = null;
    });
    list.addEventListener("dragover", (event) => {
      if (!dragId) {
        return;
      }
      event.preventDefault();
      const over = event.target.closest(".ias-qcard");
      list.querySelectorAll('.ias-qcard[data-dropbefore="true"]').forEach((el) => delete el.dataset.dropbefore);
      if (over && over.dataset.id !== dragId) {
        over.dataset.dropbefore = "true";
      }
    });
    list.addEventListener("drop", (event) => {
      if (!dragId) {
        return;
      }
      event.preventDefault();
      const over = event.target.closest(".ias-qcard");
      const ids = queueState.items.map((it) => it.id);
      let toIndex = over ? ids.indexOf(over.dataset.id) : ids.length - 1;
      const fromIndex = ids.indexOf(dragId);
      if (toIndex > fromIndex) {
        toIndex -= 1;
      }
      void reorderQueueItem(dragId, toIndex);
      dragId = null;
    });
  }

  // Drag-to-scroll: grab empty space in a scroll container and pan it.
  // Skips interactive elements and draggable cards so reordering/typing still work.
  function enableGrabScroll(el) {
    if (!el || el.dataset.grabScroll === "on") {
      return;
    }
    el.dataset.grabScroll = "on";
    let active = false;
    let startY = 0;
    let startTop = 0;
    let moved = false;
    let pointerId = null;
    const isInteractive = (target) =>
      target.closest(
        "button, input, textarea, select, label, a, .ias-switch, .ias-qcard, [contenteditable]"
      );
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || isInteractive(event.target)) {
        return;
      }
      active = true;
      moved = false;
      startY = event.clientY;
      startTop = el.scrollTop;
      pointerId = event.pointerId;
    });
    el.addEventListener("pointermove", (event) => {
      if (!active) {
        return;
      }
      const dy = event.clientY - startY;
      if (!moved && Math.abs(dy) < 3) {
        return;
      }
      moved = true;
      el.dataset.grabbing = "true";
      try {
        el.setPointerCapture(pointerId);
      } catch (error) {
        void error;
      }
      el.scrollTop = startTop - dy;
      event.preventDefault();
    });
    const end = () => {
      if (!active) {
        return;
      }
      active = false;
      delete el.dataset.grabbing;
      try {
        if (pointerId != null && el.hasPointerCapture(pointerId)) {
          el.releasePointerCapture(pointerId);
        }
      } catch (error) {
        void error;
      }
      pointerId = null;
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", end);
  }

  function handleEditorInput(event) {
    const field = event.target.dataset.field;
    if (!field) {
      return;
    }
    const item = getSelectedQueueItem();
    if (!item) {
      return;
    }
    if (field === "title") {
      item.title = event.target.value;
    } else if (field === "basePrompt") {
      item.basePrompt = event.target.value;
    } else if (field === "baseNegativePrompt") {
      item.baseNegativePrompt = event.target.value;
    } else if (field === "characterPrompt") {
      item.characterPrompt = event.target.value;
    } else if (field === "negativePrompt") {
      item.negativePrompt = event.target.value;
    } else if (field === "count") {
      const numeric = Number.parseInt(event.target.value, 10);
      item.count = Number.isFinite(numeric) && numeric > 0 ? Math.min(9999, numeric) : 1;
    }
    updateRowDisplay(item);
    if (ui.queueCount) {
      ui.queueCount.textContent = queueCountText();
    }
    renderControls();
    scheduleQueueSave();
  }

  function setPanelCollapsed(collapsed) {
    panelCollapsed = Boolean(collapsed);
    if (ui.shell) {
      ui.shell.dataset.collapsed = panelCollapsed ? "true" : "false";
    }
    // Collapsing while fullscreen would leave the shell stretched to inset:0,
    // an invisible full-screen overlay that swallows every click (the X then
    // "does nothing"). Drop fullscreen on collapse so the FAB returns to its
    // small corner footprint.
    if (panelCollapsed && panelFullscreen) {
      panelFullscreen = false;
      applyFullscreen();
    }
    if (!panelCollapsed) {
      // The expanded card is far larger than the fab; pull it back on-screen.
      requestAnimationFrame(clampPanelIntoView);
    }
    persistUiState();
  }

  function toggleFullscreen() {
    panelFullscreen = !panelFullscreen;
    if (panelFullscreen && panelCollapsed) {
      setPanelCollapsed(false);
    }
    applyFullscreen();
    persistUiState();
  }

  function applyFullscreen() {
    if (!ui.shell) {
      return;
    }
    ui.shell.dataset.fullscreen = panelFullscreen ? "true" : "false";
    if (ui.sideFs) {
      ui.sideFs.innerHTML = icon(panelFullscreen ? "fullscreen_exit" : "fullscreen", 20);
      ui.sideFs.title = panelFullscreen ? "전체화면 해제" : "전체화면";
    }
    if (panelFullscreen) {
      // Let the fullscreen CSS drive the size; drop any manual width/height.
      if (ui.card) {
        ui.card.style.width = "";
        ui.card.style.height = "";
      }
    } else {
      applyPanelSize();
    }
    requestAnimationFrame(clampPanelIntoView);
  }

  function persistUiState() {
    void storageSet("local", {
      [UI_STORAGE_KEY]: { collapsed: panelCollapsed, position: panelPosition, size: panelSize, fullscreen: panelFullscreen },
    });
  }

  function applyPanelPosition() {
    if (!ui.shell || !panelPosition) {
      return;
    }
    ui.shell.style.left = `${panelPosition.left}px`;
    ui.shell.style.top = `${panelPosition.top}px`;
    ui.shell.style.right = "auto";
    ui.shell.style.bottom = "auto";
  }

  function applyPanelSize() {
    if (!ui.card || !panelSize) {
      return;
    }
    ui.card.style.width = `${panelSize.width}px`;
    ui.card.style.height = `${panelSize.height}px`;
  }

  function enableDrag(handle, options = {}) {
    if (!handle) {
      return;
    }
    const tapToOpen = Boolean(options.tapToOpen);
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;
    let moved = false;

    handle.addEventListener("pointerdown", (event) => {
      // On non-fab handles, ignore drags that start on interactive controls.
      if (!tapToOpen && event.target.closest("button, input, textarea, label, .ias-list, .ias-scroll")) {
        return;
      }
      dragging = true;
      moved = false;
      const rect = ui.shell.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      startX = event.clientX;
      startY = event.clientY;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        void error;
      }
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging) {
        return;
      }
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 5) {
        moved = true;
        if (tapToOpen) {
          handle.dataset.dragging = "true";
        }
      }
      if (!moved) {
        return;
      }
      const rect = ui.shell.getBoundingClientRect();
      const maxLeft = Math.max(4, window.innerWidth - rect.width - 4);
      const maxTop = Math.max(4, window.innerHeight - rect.height - 4);
      const left = Math.max(4, Math.min(maxLeft, originLeft + dx));
      const top = Math.max(4, Math.min(maxTop, originTop + dy));
      panelPosition = { left, top };
      applyPanelPosition();
    });
    const endDrag = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      delete handle.dataset.dragging;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (error) {
        void error;
      }
      if (moved) {
        clampPanelIntoView();
        persistUiState();
      } else if (tapToOpen) {
        setPanelCollapsed(false);
      }
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  function enableResize(handle) {
    if (!handle) {
      return;
    }
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let resizing = false;

    handle.addEventListener("pointerdown", (event) => {
      resizing = true;
      const rect = ui.card.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      startX = event.clientX;
      startY = event.clientY;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        void error;
      }
      event.preventDefault();
      event.stopPropagation();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!resizing) {
        return;
      }
      const rect = ui.card.getBoundingClientRect();
      const maxW = Math.max(380, window.innerWidth - rect.left - 8);
      const maxH = Math.max(320, window.innerHeight - rect.top - 8);
      const width = Math.max(380, Math.min(maxW, startW + (event.clientX - startX)));
      const height = Math.max(320, Math.min(maxH, startH + (event.clientY - startY)));
      panelSize = { width: Math.round(width), height: Math.round(height) };
      applyPanelSize();
    });
    const endResize = (event) => {
      if (!resizing) {
        return;
      }
      resizing = false;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (error) {
        void error;
      }
      persistUiState();
    };
    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
  }

  function clampPanelIntoView() {
    if (!ui.shell || !panelPosition || panelFullscreen) {
      return;
    }
    const rect = ui.shell.getBoundingClientRect();
    const maxLeft = Math.max(4, window.innerWidth - rect.width - 4);
    const maxTop = Math.max(4, window.innerHeight - rect.height - 4);
    panelPosition = {
      left: Math.max(4, Math.min(maxLeft, panelPosition.left)),
      top: Math.max(4, Math.min(maxTop, panelPosition.top)),
    };
    applyPanelPosition();
  }

  function getStyles() {
    return `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }

      .ias-shell {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483600;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
        color: #1c1c1e;
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
      }
      .ias-ic { display: block; flex: 0 0 auto; }

      /* ---- collapsed floating button ---- */
      .ias-fab {
        display: flex; align-items: center; justify-content: center;
        width: 56px; height: 56px; border-radius: 50%;
        background: #007aff; color: #fff; cursor: grab;
        border: none;
        box-shadow: 0 8px 24px rgba(0, 122, 255, 0.42), 0 2px 6px rgba(0,0,0,0.18);
        touch-action: none; user-select: none;
        transition: transform 0.12s ease, box-shadow 0.2s ease, background 0.2s ease;
      }
      .ias-fab:active { cursor: grabbing; transform: scale(0.95); }
      .ias-fab[data-running="true"] { background: #ff3b30; box-shadow: 0 8px 24px rgba(255,59,48,0.45); }
      .ias-fab[data-dragging="true"] { transform: scale(1.06); }
      .ias-shell[data-collapsed="true"] .ias-card { display: none; }
      .ias-shell[data-collapsed="false"] .ias-fab { display: none; }
      .ias-shell[data-editor-expanded="true"] .ias-card { width: min(820px, calc(100vw - 32px)); height: min(720px, calc(100vh - 40px)); }

      /* ---- fullscreen mode (overrides drag position & manual size) ---- */
      .ias-shell[data-fullscreen="true"] { inset: 0 !important; right: auto; bottom: auto; }
      .ias-shell[data-fullscreen="true"] .ias-card {
        width: calc(100vw - 24px) !important;
        height: calc(100vh - 24px) !important;
        margin: 12px;
        border-radius: 22px;
      }
      .ias-shell[data-fullscreen="true"] .ias-resize { display: none; }
      /* A collapsed FAB must never inherit the full-screen overlay footprint. */
      .ias-shell[data-collapsed="true"][data-fullscreen="true"] {
        inset: auto !important; right: 20px !important; bottom: 20px !important;
      }

      /* ---- expanded white-mode glass card ---- */
      .ias-card {
        position: relative;
        display: flex;
        flex-direction: row;
        width: min(620px, calc(100vw - 32px));
        height: min(560px, calc(100vh - 40px));
        background: rgba(248, 248, 250, 0.82);
        backdrop-filter: blur(28px) saturate(180%);
        -webkit-backdrop-filter: blur(28px) saturate(180%);
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 24px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.24), 0 4px 12px rgba(0, 0, 0, 0.12);
        overflow: hidden;
        min-width: 380px; min-height: 320px;
      }
      .ias-resize {
        position: absolute; right: 0; bottom: 0;
        width: 28px; height: 28px;
        display: flex; align-items: flex-end; justify-content: flex-end;
        padding: 4px;
        color: #c0c0c5; cursor: nwse-resize; touch-action: none;
        z-index: 5;
      }
      .ias-resize:hover { color: #007aff; }
      .ias-resize .ias-ic { transform: rotate(45deg); }

      /* ---- left tab sidebar ---- */
      .ias-side {
        flex: 0 0 76px;
        display: flex; flex-direction: column; align-items: center;
        padding: 14px 0;
        background: rgba(255, 255, 255, 0.55);
        border-right: 1px solid rgba(0, 0, 0, 0.07);
        cursor: grab; touch-action: none; user-select: none;
      }
      .ias-side:active { cursor: grabbing; }
      .ias-side-logo {
        display: flex; align-items: center; justify-content: center;
        width: 38px; height: 38px; border-radius: 11px;
        background: transparent; color: rgba(0,0,0,0.22); margin-bottom: 18px;
        cursor: grab; touch-action: none;
      }
      .ias-side-logo:hover { color: rgba(0,0,0,0.38); }
      .ias-side-logo:active { cursor: grabbing; }
      .ias-tabs { display: flex; flex-direction: column; gap: 6px; width: 100%; align-items: center; }
      .ias-tab {
        display: flex; flex-direction: column; align-items: center; gap: 3px;
        width: 60px; padding: 9px 0; border: none; border-radius: 14px;
        background: transparent; color: #8e8e93; cursor: pointer;
        font-size: 10.5px; font-weight: 600; letter-spacing: -0.1px;
        transition: background 0.16s ease, color 0.16s ease;
      }
      .ias-tab:hover { background: rgba(0, 0, 0, 0.04); }
      .ias-tab[data-active="true"] { color: #007aff; background: rgba(0, 122, 255, 0.12); }
      .ias-side-foot { margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: 8px; }
      .ias-side-fs {
        display: flex; align-items: center; justify-content: center;
        width: 36px; height: 36px; border-radius: 50%;
        border: none; background: rgba(0,122,255,0.10); color: #007aff; cursor: pointer;
        transition: background 0.16s ease;
      }
      .ias-side-fs:hover { background: rgba(0,122,255,0.2); }
      .ias-shell[data-fullscreen="true"] .ias-side-fs { background: rgba(0,122,255,0.18); }
      .ias-side-close {
        display: flex; align-items: center; justify-content: center;
        width: 36px; height: 36px; border-radius: 50%;
        border: none; background: rgba(0,0,0,0.05); color: #8e8e93; cursor: pointer;
        transition: background 0.16s ease;
      }
      .ias-side-close:hover { background: rgba(0,0,0,0.1); }

      /* ---- right content ---- */
      .ias-main {
        flex: 1 1 auto; min-width: 0;
        display: flex; flex-direction: column;
        padding: 22px 22px 16px;
        overflow: hidden;
      }
      .ias-main-head {
        font-size: 22px; font-weight: 700; letter-spacing: -0.4px;
        color: #1c1c1e; margin-bottom: 16px; flex: 0 0 auto;
        cursor: grab; touch-action: none; user-select: none;
      }
      .ias-main-head:active { cursor: grabbing; }
      .ias-pane { display: none; flex-direction: column; min-height: 0; flex: 1 1 auto; }
      .ias-pane[data-active="true"] { display: flex; }
      .ias-scroll { overflow-y: auto; overflow-x: hidden; flex: 1 1 auto; padding-right: 4px; margin-right: -4px; }
      .ias-scroll::-webkit-scrollbar { width: 8px; }
      .ias-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.18); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
      .ias-scroll[data-grab-scroll="on"], .ias-list[data-grab-scroll="on"] { cursor: grab; }
      .ias-scroll[data-grabbing="true"], .ias-list[data-grabbing="true"] { cursor: grabbing; user-select: none; }

      /* ---- form elements (iOS light) ---- */
      .ias-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
      .ias-field label { font-size: 12px; font-weight: 600; color: #6e6e73; padding-left: 2px; }
      .ias-hint { font-size: 11.5px; color: #8e8e93; line-height: 1.45; margin: 0; }
      .ias-row { display: flex; gap: 10px; }
      .ias-row .ias-field { flex: 1; }

      .ias-input, textarea.ias-input {
        width: 100%;
        background: #fff;
        border: 1px solid rgba(0, 0, 0, 0.10);
        border-radius: 12px;
        color: #1c1c1e;
        padding: 11px 13px;
        font-size: 14px;
        font-family: inherit;
        transition: border-color 0.16s ease, box-shadow 0.16s ease;
      }
      .ias-input:focus, textarea.ias-input:focus {
        outline: none;
        border-color: #007aff;
        box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.18);
      }
      .ias-input::placeholder { color: #b0b0b5; }
      textarea.ias-input { resize: vertical; line-height: 1.55; }

      .ias-presets { display: flex; gap: 7px; margin: 4px 0 14px; }
      .ias-presets button {
        flex: 1; padding: 9px 0; font-size: 13px; font-weight: 600;
        background: rgba(0, 122, 255, 0.10); color: #007aff;
        border: none; border-radius: 11px; cursor: pointer;
        transition: background 0.14s ease, transform 0.1s ease;
      }
      .ias-presets button:hover { background: rgba(0, 122, 255, 0.18); }
      .ias-presets button:active { transform: scale(0.94); }

      .ias-btn {
        width: 100%;
        display: flex; align-items: center; justify-content: center; gap: 7px;
        border: none; border-radius: 13px; cursor: pointer;
        padding: 13px; font-size: 15px; font-weight: 600; letter-spacing: -0.1px;
        background: #007aff; color: #fff;
        font-family: inherit;
        transition: filter 0.16s ease, transform 0.1s ease;
      }
      .ias-btn:not(:disabled):hover { filter: brightness(1.05); }
      .ias-btn:not(:disabled):active { transform: scale(0.985); }
      .ias-btn:disabled { background: #c7c7cc; color: #fff; cursor: not-allowed; }
      .ias-btn[data-active="true"] { background: #ff3b30; }
      .ias-btn.secondary { background: rgba(0, 122, 255, 0.10); color: #007aff; }
      .ias-btn.secondary:not(:disabled):hover { background: rgba(0, 122, 255, 0.18); filter: none; }

      .ias-toggle-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.06);
      }
      .ias-toggle-row:last-child { border-bottom: none; }
      .ias-toggle-row .ias-tr-text { display: flex; flex-direction: column; gap: 2px; }
      .ias-toggle-row .ias-tr-text strong { font-size: 14px; font-weight: 500; color: #1c1c1e; }
      .ias-toggle-row .ias-tr-text small { font-size: 11.5px; color: #8e8e93; }

      .ias-switch { position: relative; width: 51px; height: 31px; flex: 0 0 auto; }
      .ias-switch input { opacity: 0; width: 0; height: 0; }
      .ias-switch .ias-slider {
        position: absolute; inset: 0; cursor: pointer;
        background: #e9e9ea; border-radius: 999px;
        transition: 0.28s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .ias-switch .ias-slider::before {
        content: ""; position: absolute;
        height: 27px; width: 27px; left: 2px; top: 2px;
        background: #fff; border-radius: 50%;
        box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        transition: 0.28s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .ias-switch input:checked + .ias-slider { background: #34c759; }
      .ias-switch input:checked + .ias-slider::before { transform: translateX(20px); }

      /* ---- section blocks ---- */
      .ias-block { margin-bottom: 18px; }
      .ias-block-title {
        font-size: 12px; font-weight: 700; color: #8e8e93;
        text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 10px 2px;
      }

      /* ---- queue: left list / right editor split ---- */
      .ias-queue-bar {
        display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
      }
      .ias-queue-count { font-size: 12px; color: #8e8e93; }

      .ias-qopts { margin-bottom: 12px; }
      .ias-qopt-row { display: flex; gap: 8px; margin-bottom: 4px; }
      .ias-qopt-row .ias-input { flex: 1; font-size: 13px; padding: 9px 12px; }
      .ias-name-pattern-apply { width: auto !important; padding: 9px 12px !important; font-size: 12.5px !important; white-space: nowrap; }
      .ias-bulk-count-set, .ias-bulk-count-add { width: auto !important; padding: 9px 12px !important; font-size: 12.5px !important; white-space: nowrap; flex: 0 0 auto; }

      /* ---- combination generator ---- */
      .ias-gen-scroll { padding-bottom: 6px; }
      .ias-gen-section-head {
        display: flex; align-items: center; justify-content: space-between;
        margin: 4px 0 8px;
      }
      .ias-gen-section-head .ias-btn.secondary {
        width: auto !important; padding: 7px 12px !important; font-size: 12.5px !important;
        white-space: nowrap; flex: 0 0 auto;
      }
      .ias-gen-chars, .ias-gen-bgs { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
      .ias-gen-char-row, .ias-gen-bg-row {
        display: flex; flex-direction: column; gap: 8px;
        padding: 12px; border-radius: 14px;
        background: rgba(255, 255, 255, 0.55);
        border: 1px solid rgba(0, 0, 0, 0.07);
      }
      .ias-gen-row-head { display: flex; align-items: center; gap: 8px; }
      .ias-gen-row-head .ias-input { flex: 1; }
      .ias-gc-label { font-size: 11px; font-weight: 600; color: #8e8e93; margin: 2px 0 -3px 2px; }
      .ias-gen-empty { font-size: 12px; color: #b0b0b5; padding: 10px 2px; }
      .ias-icon-btn {
        display: flex; align-items: center; justify-content: center;
        width: 34px; height: 34px; flex: 0 0 auto; border-radius: 10px;
        border: none; cursor: pointer;
        background: rgba(255, 59, 48, 0.10); color: #ff3b30;
        transition: background 0.16s ease;
      }
      .ias-icon-btn:hover { background: rgba(255, 59, 48, 0.18); }
      .ias-gen-foot {
        flex: 0 0 auto; padding-top: 12px; margin-top: 6px;
        border-top: 1px solid rgba(0, 0, 0, 0.07);
      }
      .ias-gen-preview {
        font-size: 12.5px; font-weight: 600; color: #6e6e73;
        text-align: center; padding: 6px 0 10px;
        background: transparent; border: none;
      }
      .ias-gen-preview strong { color: #007aff; font-weight: 700; }
      .ias-gen-foot .ias-btn.secondary { width: 100%; }
      .ias-gen-foot .ias-row .ias-btn.secondary { flex: 1; }

      /* ---- prompt memos ---- */
      .ias-memo-tools { display: flex; gap: 8px; margin-bottom: 12px; }
      .ias-memo-tools .ias-btn { flex: 1; padding: 10px 8px; font-size: 12.5px; }
      .ias-memo-fields { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
      .ias-memo-field {
        padding: 11px; border-radius: 14px; background: rgba(255,255,255,0.58);
        border: 1px solid rgba(0,0,0,0.07);
      }
      .ias-memo-field-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .ias-memo-field-head input { width: 17px; height: 17px; accent-color: #007aff; }
      .ias-memo-field-head label { padding: 0; color: #1c1c1e; font-size: 13px; cursor: pointer; }
      .ias-memo-field textarea:disabled { opacity: 0.45; background: rgba(255,255,255,0.55); }
      .ias-memo-save-row { display: flex; gap: 8px; margin: 2px 0 18px; }
      .ias-memo-save-row .ias-btn { flex: 1; }
      .ias-memo-list-head {
        min-height: 34px; margin: 0 0 9px;
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
      }
      .ias-memo-list { display: flex; flex-direction: column; gap: 10px; padding: 1px 0 10px; }
      .ias-memo-card {
        position: relative; isolation: isolate;
        flex: 0 0 auto; width: 100%; min-width: 0;
        display: flex; flex-direction: column; gap: 10px;
        padding: 14px; border-radius: 17px;
        background: rgba(255,255,255,0.66);
        -webkit-backdrop-filter: blur(18px) saturate(165%);
        backdrop-filter: blur(18px) saturate(165%);
        border: 1px solid rgba(255,255,255,0.78);
        box-shadow: inset 0 0 0 1px rgba(0,0,0,0.045), 0 7px 22px rgba(25,28,38,0.055);
        transition: border-color 0.16s ease, box-shadow 0.18s ease, transform 0.16s ease;
      }
      .ias-memo-card:hover {
        border-color: rgba(255,255,255,0.96);
        box-shadow: inset 0 0 0 1px rgba(0,122,255,0.13), 0 10px 28px rgba(25,28,38,0.075);
      }
      .ias-memo-card[data-menu-open="true"] { z-index: 20; }
      .ias-memo-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .ias-memo-order {
        flex: 0 0 auto; width: 22px; height: 22px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: #007aff; color: #fff; font-size: 11px; font-weight: 700;
        box-shadow: 0 2px 7px rgba(0,122,255,0.24);
      }
      .ias-memo-title {
        flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-size: 13.5px; font-weight: 650; letter-spacing: -0.15px; color: #1c1c1e;
      }
      .ias-memo-count {
        flex: 0 0 auto; min-width: 31px; height: 22px; padding: 0 8px;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 999px; background: rgba(0,122,255,0.10);
        color: #007aff; font-size: 10.5px; font-weight: 700;
      }
      .ias-memo-preview {
        margin: -1px 1px 0; font-size: 11.5px; line-height: 1.45; color: #7d7d84;
        height: 33px; overflow: hidden; overflow-wrap: anywhere;
      }
      .ias-memo-chips { display: flex; flex-wrap: wrap; gap: 6px; min-height: 21px; }
      .ias-memo-chips span {
        padding: 4px 8px; border-radius: 999px;
        background: rgba(118,118,128,0.09); color: #63636a;
        border: 1px solid rgba(255,255,255,0.64);
        font-size: 10px; line-height: 1; font-weight: 600;
      }
      .ias-memo-card-actions {
        position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 38px;
        gap: 8px; align-items: center; margin-top: 1px;
      }
      .ias-memo-queue {
        min-width: 0; height: 38px;
        display: flex; align-items: center; justify-content: center; gap: 6px;
        border: none; border-radius: 12px; padding: 0 13px; cursor: pointer;
        background: rgba(0,122,255,0.12); color: #007aff;
        box-shadow: inset 0 0 0 1px rgba(0,122,255,0.055);
        font-family: inherit; font-size: 12px; font-weight: 700; letter-spacing: -0.1px;
        transition: background 0.15s ease, transform 0.1s ease;
      }
      .ias-memo-queue:hover { background: rgba(0,122,255,0.19); }
      .ias-memo-queue:active { transform: scale(0.985); }
      .ias-memo-more {
        width: 38px; height: 38px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        border: 1px solid rgba(255,255,255,0.76); border-radius: 12px;
        background: rgba(118,118,128,0.09); color: #626269; cursor: pointer;
        box-shadow: inset 0 0 0 1px rgba(0,0,0,0.025);
        transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
      }
      .ias-memo-more:hover, .ias-memo-more[aria-expanded="true"] { background: rgba(0,122,255,0.13); color: #007aff; }
      .ias-memo-more:active { transform: scale(0.94); }
      .ias-more-dots {
        position: relative; width: 3px; height: 3px; border-radius: 50%;
        background: currentColor; box-shadow: -6px 0 0 currentColor, 6px 0 0 currentColor;
      }
      .ias-memo-menu {
        position: absolute; right: 0; z-index: 30; width: min(224px, calc(100vw - 56px));
        padding: 6px; border-radius: 16px;
        background: rgba(246,246,249,0.80);
        -webkit-backdrop-filter: blur(26px) saturate(185%);
        backdrop-filter: blur(26px) saturate(185%);
        border: 1px solid rgba(255,255,255,0.82);
        box-shadow: inset 0 0 0 1px rgba(0,0,0,0.045), 0 20px 54px rgba(23,25,34,0.22), 0 3px 10px rgba(23,25,34,0.10);
        transform-origin: top right;
        animation: ias-memo-menu-in 0.16s cubic-bezier(0.22,0.8,0.24,1);
      }
      .ias-memo-menu[hidden] { display: none; }
      .ias-memo-menu[data-placement="above"] { bottom: calc(100% + 9px); transform-origin: bottom right; }
      .ias-memo-menu[data-placement="below"] { top: calc(100% + 9px); transform-origin: top right; }
      @keyframes ias-memo-menu-in {
        from { opacity: 0; transform: translateY(-3px) scale(0.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .ias-memo-menu-item {
        width: 100%; height: 40px; padding: 0 11px;
        display: flex; align-items: center; justify-content: flex-start; gap: 10px;
        border: none; border-radius: 11px; background: transparent;
        color: #1c1c1e; cursor: pointer; font-family: inherit;
        font-size: 12.5px; font-weight: 600; text-align: left;
        transition: background 0.12s ease, transform 0.08s ease;
      }
      .ias-memo-menu-item .ias-ic { flex: 0 0 auto; color: #74747b; }
      .ias-memo-menu-item:hover { background: rgba(0,122,255,0.11); }
      .ias-memo-menu-item:active { transform: scale(0.985); }
      .ias-memo-menu-item[data-danger="true"] { color: #ff3b30; }
      .ias-memo-menu-item[data-danger="true"] .ias-ic { color: #ff3b30; }
      .ias-memo-menu-item[data-danger="true"]:hover { background: rgba(255,59,48,0.10); }
      .ias-memo-menu-separator { height: 1px; margin: 5px 8px; background: rgba(60,60,67,0.14); }

      .ias-qcard[data-dragging="true"] { opacity: 0.45; }
      .ias-qcard[data-dropbefore="true"] { box-shadow: 0 -3px 0 0 #007aff, 0 0 0 1px rgba(0,122,255,0.4); }

      .ias-qeditor-headrow { display: flex; align-items: center; justify-content: space-between; }
      .ias-fs-btn {
        display: inline-flex; align-items: center; gap: 5px;
        background: rgba(0,122,255,0.10); color: #007aff; border: none;
        border-radius: 9px; padding: 6px 11px; font-size: 12px; font-weight: 600;
        cursor: pointer; font-family: inherit; text-transform: none; letter-spacing: 0;
        transition: background 0.14s ease;
      }
      .ias-fs-btn:hover { background: rgba(0,122,255,0.18); }
      .ias-queue-split {
        display: flex; gap: 12px; flex: 1 1 auto; min-height: 0;
      }
      .ias-list {
        flex: 1 1 50%; min-width: 0;
        display: flex; flex-direction: column; gap: 8px;
        overflow-y: auto; overflow-x: hidden;
        padding: 2px 6px 6px 2px; align-content: flex-start;
      }
      .ias-queue-split > .ias-scroll {
        flex: 1 1 50%; min-width: 0; margin-right: 0; padding-right: 6px;
        border-left: 1px solid rgba(0,0,0,0.06); padding-left: 12px;
      }
      .ias-list::-webkit-scrollbar { width: 8px; }
      .ias-list::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.18); border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
      .ias-empty { font-size: 12.5px; color: #8e8e93; padding: 14px 4px; }
      .ias-qcard {
        flex: 0 0 auto; width: 100%; min-width: 0;
        display: flex; flex-direction: column; gap: 8px;
        padding: 11px; border-radius: 14px; cursor: pointer;
        background: #fff; border: 1px solid rgba(0,0,0,0.08);
        transition: border-color 0.14s ease, box-shadow 0.16s ease;
      }
      .ias-qcard:hover { border-color: rgba(0,122,255,0.4); }
      .ias-qcard[data-selected="true"] { border-color: #007aff; box-shadow: 0 0 0 2px rgba(0,122,255,0.25); }
      .ias-qcard[data-running="true"] { border-color: #34c759; box-shadow: 0 0 0 2px rgba(52,199,89,0.3); }
      .ias-qcard-top { display: flex; align-items: center; gap: 7px; min-width: 0; }
      .ias-qorder {
        flex: 0 0 auto; width: 20px; height: 20px; border-radius: 50%;
        background: #007aff; color: #fff; font-size: 11px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
      }
      .ias-qname { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 600; color: #1c1c1e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ias-qprev { font-size: 11px; color: #8e8e93; line-height: 1.4; height: 30px; overflow: hidden; overflow-wrap: anywhere; }
      .ias-qmeta { font-size: 11px; color: #007aff; font-weight: 600; }
      .ias-qcard-tools { display: flex; gap: 4px; }
      .ias-qcard-tools button {
        flex: 1; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.04); border: none; border-radius: 8px; color: #6e6e73; cursor: pointer;
        transition: background 0.14s ease;
      }
      .ias-qcard-tools button:hover:not(:disabled) { background: rgba(0,0,0,0.1); }
      .ias-qcard-tools button[data-danger="true"]:hover:not(:disabled) { background: rgba(255,59,48,0.14); color: #ff3b30; }
      .ias-qcard-tools button:disabled { opacity: 0.3; cursor: not-allowed; }

      /* ---- queue editor (detail) ---- */
      .ias-qeditor { margin-top: 6px; }
      .ias-qeditor:empty { display: none; }
      .ias-qeditor-head { font-size: 12px; font-weight: 700; color: #8e8e93; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
      .ias-qeditor-toprow { display: flex; gap: 10px; }
      .ias-qeditor-toprow .ias-field { flex: 1; }
      .ias-qeditor-count { flex: 0 0 96px !important; }
      .ias-qeditor-count .ias-input { text-align: right; }
      textarea.ias-qbig { min-height: 110px; font-size: 13.5px; }

      .ias-status {
        flex: 0 0 auto; font-size: 12px; color: #8e8e93; min-height: 16px;
        padding-top: 10px; text-align: center; line-height: 1.4;
      }
      .ias-status[data-tone="ok"] { color: #34c759; }
      .ias-status[data-tone="warn"] { color: #ff9500; }
    `;
  }

  function getTemplate() {
    return `
      <style>${getStyles()}</style>
      <div class="ias-shell" data-collapsed="true">
        <button class="ias-fab" type="button" title="NAI 자동저장">${icon("play_arrow", 26)}</button>
        <div class="ias-card">
          <div class="ias-side" title="여기 빈 공간이나 상단 제목을 잡고 드래그하면 창을 옮길 수 있어요">
            <div class="ias-tabs">
              <button class="ias-tab" type="button" data-tab="auto" data-active="true">${icon("bolt", 22)}<span>자동생성</span></button>
              <button class="ias-tab" type="button" data-tab="memo">${icon("label", 22)}<span>메모</span></button>
              <button class="ias-tab" type="button" data-tab="queue">${icon("lists", 22)}<span>대기열</span></button>
              <button class="ias-tab" type="button" data-tab="gen">${icon("content_copy", 22)}<span>조합생성</span></button>
              <button class="ias-tab" type="button" data-tab="settings">${icon("settings", 22)}<span>설정</span></button>
            </div>
            <div class="ias-side-foot">
              <button class="ias-side-fs" type="button" title="전체화면">${icon("fullscreen", 20)}</button>
              <button class="ias-side-close" type="button" title="접기">${icon("close", 20)}</button>
            </div>
          </div>
          <div class="ias-main">
            <!-- AUTO -->
            <div class="ias-pane" data-pane="auto" data-active="true">
              <div class="ias-main-head">자동 생성</div>
              <div class="ias-scroll">
                <div class="ias-field">
                  <label>저장 이름</label>
                  <input class="ias-input ias-save-name" type="text" placeholder="예: 1_b_c">
                  <p class="ias-hint">단발 실행에만 적용됩니다. 대기열은 항목마다 따로 저장 이름을 씁니다. (저장 폴더는 설정 탭)</p>
                </div>
                <div class="ias-field">
                  <label>베이스 프롬프트</label>
                  <textarea class="ias-input ias-auto-base" rows="3" placeholder="장면 · 스타일 · 화질 태그 · 비우면 현재 NovelAI 베이스 프롬프트 그대로 사용"></textarea>
                </div>
                <div class="ias-field">
                  <label>베이스 네거티브 (베이스 Undesired Content)</label>
                  <textarea class="ias-input ias-auto-base-neg" rows="3" placeholder="베이스 Undesired Content에 적용 · 비우면 현재 NovelAI 값 그대로"></textarea>
                </div>
                <div class="ias-field">
                  <label>캐릭터 프롬프트</label>
                  <textarea class="ias-input ias-auto-char" rows="3" placeholder="예: girl, black hair  ·  여러 명은 ;; 로 구분 · 비우면 현재 NovelAI 캐릭터 그대로"></textarea>
                </div>
                <div class="ias-field">
                  <label>캐릭터 네거티브 (캐릭터 Undesired Content)</label>
                  <textarea class="ias-input ias-auto-char-neg" rows="3" placeholder="각 캐릭터 Undesired Content에 적용 · 여러 캐릭터는 ;; 로 구분 · 비우면 그대로"></textarea>
                </div>
                <div class="ias-row">
                  <div class="ias-field">
                    <label>횟수 (0 = 무제한)</label>
                    <input class="ias-input ias-count" type="number" min="0" step="1" placeholder="0">
                  </div>
                  <div class="ias-field">
                    <label>주기(초)</label>
                    <input class="ias-input ias-interval" type="number" min="0.1" step="0.1" placeholder="3">
                  </div>
                </div>
                <div class="ias-presets">
                  <button type="button" data-count="10">10</button>
                  <button type="button" data-count="20">20</button>
                  <button type="button" data-count="50">50</button>
                  <button type="button" data-count="88">88</button>
                  <button type="button" data-count="100">100</button>
                </div>
                <button class="ias-btn ias-auto" type="button">${icon("play_arrow", 20)}<span>자동 생성 시작</span></button>
              </div>
            </div>
            <!-- PROMPT MEMOS -->
            <div class="ias-pane" data-pane="memo">
              <div class="ias-main-head">프롬프트 메모</div>
              <div class="ias-scroll">
                <div class="ias-field">
                  <label>메모 이름</label>
                  <input class="ias-input ias-memo-name" type="text" maxlength="80" placeholder="예: 실내 기본 세트 / 캐릭터 A 네거티브">
                  <p class="ias-hint">4개 중 필요한 항목만 체크해 저장합니다. 4개를 모두 체크하면 한 세트로 저장됩니다.</p>
                </div>
                <div class="ias-memo-tools">
                  <button class="ias-btn secondary ias-memo-capture" type="button">${icon("download", 17)}<span>NAI 현재값 읽기</span></button>
                  <button class="ias-btn secondary ias-memo-copy-auto" type="button">${icon("content_copy", 17)}<span>자동생성 값 가져오기</span></button>
                </div>
                <div class="ias-memo-fields">
                  <div class="ias-memo-field">
                    <div class="ias-memo-field-head"><input class="ias-memo-base-check" id="ias-memo-base-check" type="checkbox" checked><label for="ias-memo-base-check">베이스 프롬프트</label></div>
                    <textarea class="ias-input ias-memo-base" rows="3" placeholder="베이스 프롬프트"></textarea>
                  </div>
                  <div class="ias-memo-field">
                    <div class="ias-memo-field-head"><input class="ias-memo-base-neg-check" id="ias-memo-base-neg-check" type="checkbox" checked><label for="ias-memo-base-neg-check">베이스 네거티브</label></div>
                    <textarea class="ias-input ias-memo-base-neg" rows="3" placeholder="베이스 Undesired Content"></textarea>
                  </div>
                  <div class="ias-memo-field">
                    <div class="ias-memo-field-head"><input class="ias-memo-char-check" id="ias-memo-char-check" type="checkbox" checked><label for="ias-memo-char-check">캐릭터 태그</label></div>
                    <textarea class="ias-input ias-memo-char" rows="3" placeholder="여러 캐릭터는 ;; 로 구분"></textarea>
                  </div>
                  <div class="ias-memo-field">
                    <div class="ias-memo-field-head"><input class="ias-memo-char-neg-check" id="ias-memo-char-neg-check" type="checkbox" checked><label for="ias-memo-char-neg-check">캐릭터 네거티브</label></div>
                    <textarea class="ias-input ias-memo-char-neg" rows="3" placeholder="여러 캐릭터는 ;; 로 구분"></textarea>
                  </div>
                </div>
                <div class="ias-memo-save-row">
                  <button class="ias-btn ias-memo-save" type="button">${icon("playlist_add", 18)}<span>새 메모 저장</span></button>
                  <button class="ias-btn secondary ias-memo-cancel-edit" type="button" hidden>${icon("close", 18)}<span>수정 취소</span></button>
                </div>
                <div class="ias-memo-list-head">
                  <div class="ias-block-title" style="margin:0;">저장된 메모</div>
                </div>
                <input class="ias-memo-import-file" type="file" accept="application/json,.json" hidden>
                <div class="ias-memo-list"></div>
              </div>
            </div>
            <!-- QUEUE -->
            <div class="ias-pane" data-pane="queue">
              <div class="ias-main-head">대기열</div>
              <div class="ias-queue-bar">
                <span class="ias-queue-count">비어 있음</span>
                <button class="ias-btn secondary ias-queue-add" type="button" style="width:auto;padding:8px 14px;font-size:13px;">${icon("playlist_add", 18)}<span>현재 프롬프트 추가</span></button>
              </div>
              <div class="ias-qopts">
                <div class="ias-qopt-row">
                  <input class="ias-input ias-name-pattern" type="text" placeholder="이름 패턴 예: char_{n}  ({n}/{nn}/{nnn})">
                  <button class="ias-btn secondary ias-name-pattern-apply" type="button" title="모든 항목에 패턴 적용">${icon("label", 16)}<span>일괄적용</span></button>
                </div>
                <div class="ias-qopt-row">
                  <input class="ias-input ias-bulk-count" type="number" min="1" step="1" placeholder="장수 일괄 (예: 30)">
                  <button class="ias-btn secondary ias-bulk-count-set" type="button" title="모든 항목 장수를 이 값으로 설정">${icon("tune", 16)}<span>일괄설정</span></button>
                  <button class="ias-btn secondary ias-bulk-count-add" type="button" title="모든 항목 장수에 이 값을 더하기">${icon("add", 16)}<span>추가</span></button>
                </div>
                <div class="ias-toggle-row" style="padding:8px 0;">
                  <div class="ias-tr-text"><strong>공통 Base 사용</strong><small>모든 항목이 같은 Base를 공유</small></div>
                  <label class="ias-switch"><input class="ias-global-base-toggle" type="checkbox"><span class="ias-slider"></span></label>
                </div>
                <div class="ias-field ias-global-base-field" style="display:none;margin-bottom:0;">
                  <textarea class="ias-input ias-global-base" rows="3" placeholder="공통 Base Prompt (켜면 각 항목의 Base 대신 이게 쓰입니다)"></textarea>
                </div>
              </div>
              <div class="ias-queue-split">
                <div class="ias-list"></div>
                <div class="ias-scroll ias-queue-editor-scroll">
                  <div class="ias-qeditor"></div>
                </div>
              </div>
              <button class="ias-btn ias-queue-run" type="button" disabled style="margin-top:10px;">${icon("play_arrow", 20)}<span>대기열 실행</span></button>
            </div>
            <!-- COMBINATION GENERATOR -->
            <div class="ias-pane" data-pane="gen">
              <div class="ias-main-head">조합생성</div>
              <div class="ias-scroll ias-gen-scroll">
                <div class="ias-field">
                  <label>Base 프롬프트 (모든 항목 공통)</label>
                  <textarea class="ias-input ias-gen-base" rows="3" placeholder="공통 Base 프롬프트 — 모든 조합 항목이 공유합니다 (globalBase로 저장)"></textarea>
                </div>
                <div class="ias-field">
                  <label>Base 네거티브 (모든 항목 공통 · 베이스 Undesired Content)</label>
                  <textarea class="ias-input ias-gen-base-neg" rows="3" placeholder="공통 Base 네거티브 — 생성되는 모든 항목의 베이스 Undesired Content에 들어갑니다 · 비우면 없음"></textarea>
                </div>

                <div class="ias-gen-section-head">
                  <div class="ias-block-title" style="margin:0;">캐릭터</div>
                  <button class="ias-btn secondary ias-gen-add-char" type="button">${icon("add", 16)}<span>캐릭터 추가</span></button>
                </div>
                <div class="ias-gen-chars"></div>

                <div class="ias-gen-section-head">
                  <div class="ias-block-title" style="margin:0;">배경</div>
                  <button class="ias-btn secondary ias-gen-add-bg" type="button">${icon("add", 16)}<span>배경 추가</span></button>
                </div>
                <div class="ias-gen-bgs"></div>

                <div class="ias-row" style="margin-top:4px;">
                  <div class="ias-field" style="margin-bottom:0;">
                    <label>항목당 장수</label>
                    <input class="ias-input ias-gen-count" type="number" min="1" step="1" value="1">
                  </div>
                  <div class="ias-field" style="margin-bottom:0;">
                    <label>파일당 최대 항목 (0=분할 안 함)</label>
                    <input class="ias-input ias-gen-split" type="number" min="0" step="1" value="0" placeholder="0">
                  </div>
                </div>
                <p class="ias-hint" style="margin-top:8px;">title = 캐릭터코드_배경코드_감정번호 (예: w_h_1) · characterPrompt = 외형 / 표정 / 배경 (빈 줄 2개로 구분) · 표정 줄 앞 번호는 자동 제거됩니다.</p>
              </div>

              <div class="ias-gen-foot">
                <div class="ias-row" style="gap:8px;">
                  <button class="ias-btn secondary ias-gen-append" type="button" style="font-size:13px;padding:10px;">${icon("playlist_add", 18)}<span>현재 큐에 추가</span></button>
                  <button class="ias-btn secondary ias-gen-replace" type="button" style="font-size:13px;padding:10px;">${icon("lists", 18)}<span>새 큐로 교체</span></button>
                </div>
                <button class="ias-btn secondary ias-gen-export" type="button" style="font-size:13px;padding:10px;margin-top:8px;">${icon("download", 18)}<span>JSON 내보내기</span></button>
                <div class="ias-gen-preview">총 <strong>0</strong>개 생성됨</div>
              </div>
            </div>
            <!-- SETTINGS -->
            <div class="ias-pane" data-pane="settings">
              <div class="ias-main-head">설정</div>
              <div class="ias-scroll">
                <div class="ias-block">
                  <div class="ias-block-title">저장</div>
                  <div class="ias-field">
                    <label>저장 폴더</label>
                    <input class="ias-input ias-folder" type="text" placeholder="NovelAI">
                    <p class="ias-hint">브라우저 다운로드 폴더 안의 하위 경로입니다. 예: NovelAI 또는 NovelAI/프로젝트A. 비우면 NovelAI. (브라우저 보안상 다운로드 폴더 바깥 경로는 지정할 수 없습니다 — 부모 폴더는 Chrome 설정에서 변경)</p>
                  </div>
                </div>
                <div class="ias-block">
                  <div class="ias-block-title">생성</div>
                  <div class="ias-toggle-row">
                    <div class="ias-tr-text"><strong>완료 이미지 자동 저장</strong><small>생성 완료 시 파일로 내려받기</small></div>
                    <label class="ias-switch"><input class="ias-auto-save" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                  <div class="ias-toggle-row">
                    <div class="ias-tr-text"><strong>완료 알림음</strong><small>모든 작업이 끝나면 소리로 알림</small></div>
                    <label class="ias-switch"><input class="ias-notify" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                  <div class="ias-toggle-row">
                    <div class="ias-tr-text"><strong>대기열 반복</strong><small>마지막 항목 후 처음부터 다시 실행</small></div>
                    <label class="ias-switch"><input class="ias-loop" type="checkbox"><span class="ias-slider"></span></label>
                  </div>
                </div>
                <div class="ias-block">
                  <div class="ias-block-title">대기열 관리</div>
                  <div class="ias-row" style="gap:8px;">
                    <button class="ias-btn secondary ias-queue-export" type="button" style="font-size:13px;padding:10px;">${icon("download", 18)}<span>내보내기</span></button>
                    <button class="ias-btn secondary ias-queue-import" type="button" style="font-size:13px;padding:10px;">${icon("upload", 18)}<span>가져오기</span></button>
                  </div>
                  <button class="ias-btn secondary ias-queue-clear" type="button" disabled style="font-size:13px;padding:10px;margin-top:8px;color:#ff3b30;background:rgba(255,59,48,0.10);">${icon("delete", 18)}<span>대기열 비우기</span></button>
                  <input class="ias-queue-import-file" type="file" accept="application/json,.json" hidden>
                </div>
              </div>
            </div>
            <div class="ias-status" data-tone="neutral"></div>
          </div>
          <div class="ias-resize" title="크기 조절">${icon("drag_indicator", 16)}</div>
        </div>
      </div>
    `;
  }

  function bindEvents() {
    ui.sideClose.addEventListener("click", () => setPanelCollapsed(true));
    if (ui.sideFs) {
      ui.sideFs.addEventListener("click", toggleFullscreen);
    }

    for (const tab of ui.tabs) {
      tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
    }

    if (ui.memoSaveButton) {
      // Save on the first physical press instead of relying only on `click`.
      // This avoids the first tap merely committing Korean IME text / moving the
      // memo scroller. Keyboard activation still arrives through click(detail=0).
      ui.memoSaveButton.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        void handleMemoSavePress(event);
      });
      ui.memoSaveButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.detail === 0) {
          void handleMemoSavePress(event);
        }
      });
    }
    if (ui.memoCancelEditButton) {
      ui.memoCancelEditButton.addEventListener("click", () => resetMemoDraft());
    }
    if (ui.memoCaptureButton) {
      ui.memoCaptureButton.addEventListener("click", () => void captureNovelAiValuesToMemo());
    }
    if (ui.memoCopyAutoButton) {
      ui.memoCopyAutoButton.addEventListener("click", copyAutoValuesToMemo);
    }
    if (ui.memoList) {
      ui.memoList.addEventListener("click", handleMemoListClick);
    }
    ui.memoImportFile?.addEventListener("change", () => {
      const file = ui.memoImportFile.files?.[0] || null;
      ui.memoImportFile.value = "";
      void importMemosFromFile(file);
    });
    panelShadow.addEventListener("click", (event) => {
      if (!event.target.closest(".ias-memo-card-actions")) {
        closeMemoMenus();
      }
    });
    panelShadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMemoMenus();
      }
    });
    for (const field of MEMO_FIELDS) {
      ui[field.check]?.addEventListener("change", renderMemoEditorState);
    }

    ui.autoButton.addEventListener("click", () => {
      if (autoRun.active && !queueRun.active) {
        void stopAutoGenerate({ playAudio: true });
      } else {
        void startSingleAuto();
      }
    });
    ui.queueRunButton.addEventListener("click", () => {
      if (queueRun.active) {
        void stopQueueRun();
      } else {
        void startQueueRun();
      }
    });
    ui.queueAddButton.addEventListener("click", () => void addQueueItem());
    ui.queueClearButton.addEventListener("click", () => void clearQueue());
    ui.loopToggle.addEventListener("change", () => void toggleQueueLoop());
    ui.queueExportButton.addEventListener("click", exportQueue);
    ui.queueImportButton.addEventListener("click", () => ui.queueImportFile?.click());
    ui.queueImportFile.addEventListener("change", () => {
      const file = ui.queueImportFile.files?.[0] || null;
      ui.queueImportFile.value = "";
      void importQueueFromFile(file);
    });

    ui.queueList.addEventListener("click", handleQueueListClick);
    enableQueueDragSort();
    enableGrabScroll(ui.queueList);
    panelShadow.querySelectorAll(".ias-scroll").forEach((el) => enableGrabScroll(el));
    ui.queueEditor.addEventListener("click", handleEditorClick);
    ui.queueEditor.addEventListener("input", handleEditorInput);
    ui.queueEditor.addEventListener("change", handleEditorInput);

    if (ui.globalBaseToggle) {
      ui.globalBaseToggle.addEventListener("change", () => {
        queueState.options.useGlobalBase = ui.globalBaseToggle.checked;
        void persistQueueState();
      });
    }
    if (ui.globalBaseInput) {
      ui.globalBaseInput.addEventListener("input", () => {
        queueState.options.globalBase = ui.globalBaseInput.value;
        scheduleQueueSave();
      });
    }
    if (ui.namePatternInput) {
      ui.namePatternInput.addEventListener("input", () => {
        queueState.options.namePattern = ui.namePatternInput.value;
        scheduleQueueSave();
      });
    }
    if (ui.namePatternApply) {
      ui.namePatternApply.addEventListener("click", () => void applyNamePatternToAll());
    }
    if (ui.bulkCountSetButton) {
      ui.bulkCountSetButton.addEventListener("click", () => void applyCountToAll("set"));
    }
    if (ui.bulkCountAddButton) {
      ui.bulkCountAddButton.addEventListener("click", () => void applyCountToAll("add"));
    }
    if (ui.bulkCountInput) {
      ui.bulkCountInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void applyCountToAll("set");
        }
      });
    }

    if (ui.genAddCharButton) {
      ui.genAddCharButton.addEventListener("click", () => {
        addGenCharRow();
        scheduleGenSave();
      });
    }
    if (ui.genAddBgButton) {
      ui.genAddBgButton.addEventListener("click", () => {
        addGenBgRow();
        scheduleGenSave();
      });
    }
    if (ui.genPane) {
      ui.genPane.addEventListener("input", handleGenInput);
      ui.genPane.addEventListener("click", handleGenClick);
    }
    if (ui.genAppendButton) {
      ui.genAppendButton.addEventListener("click", () => void genAppendToQueue());
    }
    if (ui.genReplaceButton) {
      ui.genReplaceButton.addEventListener("click", () => void genReplaceQueue());
    }
    if (ui.genExportButton) {
      ui.genExportButton.addEventListener("click", genExportJson);
    }

    ui.autoSaveToggle.addEventListener("change", savePreferences);
    ui.notifyToggle.addEventListener("change", savePreferences);

    ui.intervalInput.addEventListener("change", saveSingleSettings);
    ui.countInput.addEventListener("change", saveSingleSettings);
    ui.saveNameInput.addEventListener("change", saveSingleSettings);
    [ui.autoBaseInput, ui.autoBaseNegInput, ui.autoCharInput, ui.autoCharNegInput].forEach((el) => {
      if (el) {
        el.addEventListener("change", saveSingleSettings);
      }
    });
    if (ui.folderInput) {
      ui.folderInput.addEventListener("change", () => {
        const raw = ui.folderInput.value || "";
        const fixed = normalizeFolderInput(raw);
        if (fixed !== raw.trim().replace(/\\/g, "/")) {
          ui.folderInput.value = fixed;
          setStatus("저장 폴더는 다운로드 폴더 안의 하위 경로만 가능합니다. 절대경로(C:\\...)는 쓸 수 없어 폴더명만 남겼습니다. 부모 위치는 Chrome 다운로드 설정에서 바꿔주세요.", "warn");
        }
        saveSingleSettings();
      });
    }

    for (const button of ui.presetButtons) {
      button.addEventListener("click", () => {
        ui.countInput.value = button.dataset.count || "";
        saveSingleSettings();
      });
    }

    enableDrag(ui.sidebar);
    panelShadow.querySelectorAll(".ias-main-head").forEach((head) => enableDrag(head));
    enableResize(ui.resizeHandle);
    enableDrag(ui.fab, { tapToOpen: true });
  }

  function setActiveTab(name) {
    activeTab = name;
    for (const tab of ui.tabs) {
      tab.dataset.active = tab.dataset.tab === name ? "true" : "false";
    }
    for (const pane of ui.panes) {
      pane.dataset.active = pane.dataset.pane === name ? "true" : "false";
    }
  }

  async function startSingleAuto() {
    saveSingleSettings();
    const target = Math.max(0, Number.parseInt(ui.countInput?.value, 10) || 0);
    const saveName = (ui.saveNameInput?.value || "").trim();
    await startAutoGenerate({
      target,
      saveName,
      applyBasePrompt: (ui.autoBaseInput?.value || "").trim() || null,
      applyBaseNegative: (ui.autoBaseNegInput?.value || "").trim() || null,
      applyCharacterPrompt: (ui.autoCharInput?.value || "").trim() || null,
      applyCharacterNegative: (ui.autoCharNegInput?.value || "").trim() || null,
    });
  }

  async function createPanel() {
    if (panelHost) {
      return;
    }
    panelHost = document.createElement("div");
    panelHost.id = HOST_ID;
    panelShadow = panelHost.attachShadow({ mode: "open" });
    panelShadow.innerHTML = getTemplate();
    document.documentElement.append(panelHost);

    ui = {
      shell: panelShadow.querySelector(".ias-shell"),
      fab: panelShadow.querySelector(".ias-fab"),
      sidebar: panelShadow.querySelector(".ias-side"),
      tabs: Array.from(panelShadow.querySelectorAll(".ias-tab")),
      panes: Array.from(panelShadow.querySelectorAll(".ias-pane")),
      sideClose: panelShadow.querySelector(".ias-side-close"),
      sideFs: panelShadow.querySelector(".ias-side-fs"),
      card: panelShadow.querySelector(".ias-card"),
      resizeHandle: panelShadow.querySelector(".ias-resize"),
      saveNameInput: panelShadow.querySelector(".ias-save-name"),
      autoBaseInput: panelShadow.querySelector(".ias-auto-base"),
      autoBaseNegInput: panelShadow.querySelector(".ias-auto-base-neg"),
      autoCharInput: panelShadow.querySelector(".ias-auto-char"),
      autoCharNegInput: panelShadow.querySelector(".ias-auto-char-neg"),
      memoNameInput: panelShadow.querySelector(".ias-memo-name"),
      memoBaseCheck: panelShadow.querySelector(".ias-memo-base-check"),
      memoBaseInput: panelShadow.querySelector(".ias-memo-base"),
      memoBaseNegCheck: panelShadow.querySelector(".ias-memo-base-neg-check"),
      memoBaseNegInput: panelShadow.querySelector(".ias-memo-base-neg"),
      memoCharCheck: panelShadow.querySelector(".ias-memo-char-check"),
      memoCharInput: panelShadow.querySelector(".ias-memo-char"),
      memoCharNegCheck: panelShadow.querySelector(".ias-memo-char-neg-check"),
      memoCharNegInput: panelShadow.querySelector(".ias-memo-char-neg"),
      memoCaptureButton: panelShadow.querySelector(".ias-memo-capture"),
      memoCopyAutoButton: panelShadow.querySelector(".ias-memo-copy-auto"),
      memoSaveButton: panelShadow.querySelector(".ias-memo-save"),
      memoCancelEditButton: panelShadow.querySelector(".ias-memo-cancel-edit"),
      memoImportFile: panelShadow.querySelector(".ias-memo-import-file"),
      memoList: panelShadow.querySelector(".ias-memo-list"),
      folderInput: panelShadow.querySelector(".ias-folder"),
      countInput: panelShadow.querySelector(".ias-count"),
      intervalInput: panelShadow.querySelector(".ias-interval"),
      presetButtons: Array.from(panelShadow.querySelectorAll(".ias-presets button")),
      autoButton: panelShadow.querySelector(".ias-auto"),
      queueCount: panelShadow.querySelector(".ias-queue-count"),
      queueAddButton: panelShadow.querySelector(".ias-queue-add"),
      queueList: panelShadow.querySelector(".ias-list"),
      queueEditor: panelShadow.querySelector(".ias-qeditor"),
      queueRunButton: panelShadow.querySelector(".ias-queue-run"),
      globalBaseToggle: panelShadow.querySelector(".ias-global-base-toggle"),
      globalBaseField: panelShadow.querySelector(".ias-global-base-field"),
      globalBaseInput: panelShadow.querySelector(".ias-global-base"),
      namePatternInput: panelShadow.querySelector(".ias-name-pattern"),
      namePatternApply: panelShadow.querySelector(".ias-name-pattern-apply"),
      bulkCountInput: panelShadow.querySelector(".ias-bulk-count"),
      bulkCountSetButton: panelShadow.querySelector(".ias-bulk-count-set"),
      bulkCountAddButton: panelShadow.querySelector(".ias-bulk-count-add"),
      loopToggle: panelShadow.querySelector(".ias-loop"),
      queueExportButton: panelShadow.querySelector(".ias-queue-export"),
      queueImportButton: panelShadow.querySelector(".ias-queue-import"),
      queueImportFile: panelShadow.querySelector(".ias-queue-import-file"),
      queueClearButton: panelShadow.querySelector(".ias-queue-clear"),
      genPane: panelShadow.querySelector('.ias-pane[data-pane="gen"]'),
      genBase: panelShadow.querySelector(".ias-gen-base"),
      genBaseNeg: panelShadow.querySelector(".ias-gen-base-neg"),
      genChars: panelShadow.querySelector(".ias-gen-chars"),
      genBgs: panelShadow.querySelector(".ias-gen-bgs"),
      genCount: panelShadow.querySelector(".ias-gen-count"),
      genSplit: panelShadow.querySelector(".ias-gen-split"),
      genPreview: panelShadow.querySelector(".ias-gen-preview"),
      genAddCharButton: panelShadow.querySelector(".ias-gen-add-char"),
      genAddBgButton: panelShadow.querySelector(".ias-gen-add-bg"),
      genAppendButton: panelShadow.querySelector(".ias-gen-append"),
      genReplaceButton: panelShadow.querySelector(".ias-gen-replace"),
      genExportButton: panelShadow.querySelector(".ias-gen-export"),
      autoSaveToggle: panelShadow.querySelector(".ias-auto-save"),
      notifyToggle: panelShadow.querySelector(".ias-notify"),
      status: panelShadow.querySelector(".ias-status"),
    };

    bindEvents();

    const uiState = await storageGet("local", [UI_STORAGE_KEY]);
    const stored = uiState[UI_STORAGE_KEY] || {};
    panelPosition = stored.position || null;
    applyPanelPosition();
    panelSize = stored.size && stored.size.width && stored.size.height ? stored.size : null;
    applyPanelSize();
    const startCollapsed = stored.collapsed !== false;
    // Collapsed + fullscreen is the click-swallowing combo; never restore into it.
    panelFullscreen = Boolean(stored.fullscreen) && !startCollapsed;
    setPanelCollapsed(startCollapsed);
    applyFullscreen();

    await loadSettings();
    await loadEtaSeed();
    await loadQueueState();
    await loadGeneratorState();
    await loadMemoState();
    renderMemoEditorState();
    renderQueue();
    renderControls();
  }

  // ---------------------------------------------------------------------------
  // messaging
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const action = request?.action;
    if (action === "ping") {
      sendResponse({
        ok: true,
        autoActive: autoRun.active || queueRun.active,
        hasGenerateButton: Boolean(findGenerateButton()),
        promptEditorCount: findPromptEditors().length,
      });
      return false;
    }
    if (action === "openPanel" || action === "togglePanel") {
      void createPanel().then(() => {
        setPanelCollapsed(action === "togglePanel" ? !panelCollapsed : false);
      });
      sendResponse({ ok: true });
      return false;
    }
    if (action === "getContentStatus") {
      sendResponse({ ok: true, autoActive: autoRun.active || queueRun.active });
      return false;
    }
    if (action === "startAutoGenerate") {
      void createPanel().then(() => startSingleAuto());
      sendResponse({ ok: true });
      return false;
    }
    if (action === "cancelAutoGenerate") {
      void (queueRun.active ? stopQueueRun() : stopAutoGenerate({ playAudio: true }));
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  function init() {
    if (!location.href.startsWith("https://novelai.net/image")) {
      return;
    }
    void createPanel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
