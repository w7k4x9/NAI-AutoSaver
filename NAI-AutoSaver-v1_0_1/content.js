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
  const AUTO_REFRESH_MS = 500;
  // NovelAI generations are at least 512px on the short side. Low-res preview
  // placeholders that flash in during the image swap are much smaller in their
  // *natural* size, so a floor here rejects them and prevents blank saves.
  const MIN_IMAGE_DIM = 256;
  const HOST_ID = "nai-auto-saver-host";

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
        .filter(isVisible);
      for (const editor of editors) {
        const wrapper = editor.closest(".prompt-input-box-base-prompt, .prompt-input-box-prompt");
        if (wrapper) {
          return editor;
        }
      }
    }
    return findPromptEditors()[0] || null;
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

  function readCurrentNaiPrompt() {
    const editor = getBasePromptEditor();
    return editor ? htmlToPlainText(editor.innerHTML) : "";
  }

  function getCharacterPromptEditors() {
    const root = Array.from(document.querySelectorAll(".image-gen-prompt-main")).filter(isVisible)[0] || document;
    // Preferred: explicit character-prompt wrappers.
    let editors = Array.from(root.querySelectorAll(".prompt-input-box-character-prompt [contenteditable]"))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.isContentEditable)
      .filter(isVisible)
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

  function findAddCharacterButton() {
    const root = Array.from(document.querySelectorAll(".image-gen-prompt-main")).filter(isVisible)[0] || document;
    return findButtonByText(root, (text) => /add character|캐릭터\s*추가/i.test(text))
      || findButtonByText(document.body, (text) => /add character|캐릭터\s*추가/i.test(text));
  }

  async function clickAddCharacterBox() {
    const button = findAddCharacterButton();
    if (!button || button.disabled) {
      return false;
    }
    button.click();
    return true;
  }

  function readCurrentNaiCharacterPrompt() {
    const editors = getCharacterPromptEditors();
    if (!editors.length) {
      return "";
    }
    return editors
      .map((editor) => htmlToPlainText(editor.innerHTML).trim())
      .filter((text) => text.length > 0)
      .join(" | ");
  }

  async function applyPromptToNovelAi(text) {
    if (text == null || String(text).trim() === "") {
      return { ok: true, skipped: true };
    }
    const editor = getBasePromptEditor();
    if (!editor) {
      return { ok: false, error: "NovelAI 프롬프트 입력 영역을 찾지 못했습니다." };
    }
    setEditablePlainText(editor, text);
    await delay(180);
    return { ok: true };
  }

  // Write each character segment into NovelAI's real character prompt box,
  // adding boxes when needed. This is what makes the queue actually drive the
  // output (the "|" merge into the base box is ignored once character boxes exist).
  async function applyCharacterPromptsToNovelAi(segments) {
    if (!segments.length) {
      return { ok: true, applied: 0, requested: 0 };
    }
    let editors = getCharacterPromptEditors();
    let guard = 0;
    while (editors.length < segments.length && guard < 8) {
      const added = await clickAddCharacterBox();
      if (!added) {
        break;
      }
      await delay(240);
      editors = getCharacterPromptEditors();
      guard += 1;
    }

    if (!editors.length) {
      // Last resort: no character boxes at all -> use NovelAI's "|" syntax in base.
      const baseEditor = getBasePromptEditor();
      if (!baseEditor) {
        return { ok: false, error: "캐릭터 프롬프트 입력란을 찾지 못했습니다." };
      }
      const current = htmlToPlainText(baseEditor.innerHTML).trim();
      const merged = [current, ...segments].join(" | ").trimStart();
      setEditablePlainText(baseEditor, merged);
      await delay(160);
      return { ok: true, applied: segments.length, requested: segments.length, fallback: true };
    }

    const count = Math.min(segments.length, editors.length);
    for (let i = 0; i < count; i += 1) {
      setEditablePlainText(editors[i], segments[i]);
      await delay(130);
    }
    return { ok: true, applied: count, requested: segments.length };
  }

  // Apply a queue item's base prompt (to the base box) and character prompt
  // (to the character boxes) separately.
  async function applyStructuredPrompt(basePrompt, characterPrompt) {
    let base = basePrompt == null ? "" : String(basePrompt);
    let segments = String(characterPrompt == null ? "" : characterPrompt)
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    // If the base prompt itself carries "|" character pipes, peel them off so the
    // base box never duplicates character content. Use them as characters only
    // when the character field is empty.
    if (base.includes("|")) {
      const parts = base.split("|");
      base = parts[0].trim();
      const basePipes = parts.slice(1).map((part) => part.trim()).filter(Boolean);
      if (!segments.length) {
        segments = basePipes;
      }
    }
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
    try {
      const audio = new Audio(chrome.runtime.getURL(`assets/${filename}`));
      audio.volume = Math.max(0, Math.min(1, Number(volume)));
      audio.play().catch(() => {});
    } catch (error) {
      void error;
    }
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
    chrome.runtime.sendMessage({
      action: "downloadImage",
      imageUrl: dataUrl,
      fileName: `${base} (${saveContext.counter})`,
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

  async function stopAutoGenerate({ playAudio = false } = {}) {
    const wasActive = autoRun.active;
    clearAutoTimers();
    autoRun.token += 1;
    autoRun.active = false;
    autoRun.waitingForCompletion = false;
    autoRun.waitingForExistingGeneration = false;
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
    if (autoRun.target > 0 && autoRun.count >= autoRun.target) {
      await completeAutoRun();
      return;
    }
    await scheduleNextAutoClick();
  }

  async function startAutoGenerate({ target = 0, saveName = "", applyPrompt = null, applyBasePrompt = null, applyCharacterPrompt = null } = {}) {
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
    let basePrompt = readCurrentNaiPrompt();
    let characterPrompt = readCurrentNaiCharacterPrompt();
    // If the base box itself uses NovelAI's "|" syntax and there are no separate
    // character boxes, split it so base/character land in the right fields.
    if (!characterPrompt && basePrompt.includes("|")) {
      const parts = basePrompt.split("|");
      basePrompt = parts[0].trim();
      characterPrompt = parts.slice(1).map((part) => part.trim()).filter(Boolean).join(" | ");
    }
    const count = Math.max(1, Number.parseInt(ui.countInput?.value, 10) || 1);
    const pattern = queueState.options.namePattern || "";
    const patterned = pattern.trim() ? Store.applyNamePattern(pattern, queueState.items.length) : "";
    const title = patterned
      || (ui.saveNameInput?.value || "").trim()
      || `대기열 ${queueState.items.length + 1}`;
    const newItem = Store.createItem({ title, basePrompt, characterPrompt, count });
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
      characterPrompt: src.characterPrompt,
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
    } else if (field === "characterPrompt") {
      queueState.items[index].characterPrompt = Store.normalizePrompt(value);
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
        const itemBase = Store.effectiveBase(item, queueState.options);
        const startResult = await startAutoGenerate({
          target: item.count,
          saveName: item.title,
          applyBasePrompt: itemBase && itemBase.trim() ? itemBase : null,
          applyCharacterPrompt: item.characterPrompt && item.characterPrompt.trim() ? item.characterPrompt : null,
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
          setStatus(`대기열 중단: ${result?.error || "오류"}`, "warn");
          break;
        }
        queueRun.totalGenerated += item.count;
      }
    } while (!interrupted && queueRun.active && runToken === queueRun.token && queueRun.loop);

    await finishQueueRun({ completedNormally: !interrupted });
    return { ok: true };
  }

  async function finishQueueRun({ completedNormally = false } = {}) {
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
    } else {
      setStatus("대기열 실행을 중지했습니다.", "warn");
    }
  }

  async function stopQueueRun() {
    cancelQueueRun();
    await stopAutoGenerate({ playAudio: false });
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
    return `
      <div class="ias-gen-char-row">
        <div class="ias-gen-row-head">
          <input class="ias-input ias-gc-code" type="text" maxlength="40" placeholder="코드 (예: w)" value="${escapeAttr(code)}">
          <button class="ias-icon-btn ias-gc-del" type="button" title="이 캐릭터 삭제">${icon("delete", 16)}</button>
        </div>
        <textarea class="ias-input ias-gc-appear" rows="2" placeholder="외형 태그">${escapeHtml(appearance)}</textarea>
        <textarea class="ias-input ias-gc-expr" rows="4" placeholder="표정 세트 — 한 줄에 감정 1개 (줄 순서 = 감정번호)&#10;예:&#10;1 hooded eyes&#10;2 smiling">${escapeHtml(expressions)}</textarea>
      </div>`;
  }

  function genBgRowHtml(data = {}) {
    const code = data.code != null ? String(data.code) : "";
    const tags = data.tags != null ? String(data.tags) : "";
    return `
      <div class="ias-gen-bg-row">
        <div class="ias-gen-row-head">
          <input class="ias-input ias-gb-code" type="text" maxlength="40" placeholder="코드 (예: h)" value="${escapeAttr(code)}">
          <button class="ias-icon-btn ias-gb-del" type="button" title="이 배경 삭제">${icon("delete", 16)}</button>
        </div>
        <textarea class="ias-input ias-gb-tags" rows="2" placeholder="배경 태그">${escapeHtml(tags)}</textarea>
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
        }))
      : [];
    const bgs = ui.genBgs
      ? Array.from(ui.genBgs.querySelectorAll(".ias-gen-bg-row")).map((row) => ({
          code: row.querySelector(".ias-gb-code")?.value || "",
          tags: row.querySelector(".ias-gb-tags")?.value || "",
        }))
      : [];
    return {
      base: ui.genBase?.value || "",
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
      ui.genPreview.textContent = `총 ${genPreviewCount()}개 생성됨`;
    }
  }

  // Expand the raw input into queue items (character × background × expression).
  function buildGenItems() {
    const raw = collectGenRaw();
    const base = raw.base;
    const count = Math.max(1, Number.parseInt(raw.count, 10) || 1);
    const items = [];
    for (const ch of raw.chars) {
      const charCode = ch.code.trim();
      if (!charCode) {
        continue;
      }
      const expressions = parseExpressionSet(ch.expressions);
      const appearance = String(ch.appearance || "").trim();
      for (const bg of raw.bgs) {
        const bgCode = bg.code.trim();
        if (!bgCode) {
          continue;
        }
        const bgTags = String(bg.tags || "").trim();
        expressions.forEach((expr, index) => {
          const emotionNumber = index + 1;
          const characterPrompt = [appearance, expr.trim(), bgTags].join("\n\n");
          items.push(Store.createItem({
            title: `${charCode}_${bgCode}_${emotionNumber}`,
            basePrompt: base,
            characterPrompt,
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
  // settings
  // ---------------------------------------------------------------------------
  async function loadSettings() {
    const settings = await storageGet("sync", SYNC_KEYS);
    const {
      intervalTime = 3,
      gcount = "",
      singleSaveName = "",
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
    const fsBtn = document.createElement("button");
    fsBtn.type = "button";
    fsBtn.className = "ias-fs-btn";
    fsBtn.dataset.action = "fullscreen";
    fsBtn.title = "넓게 편집";
    fsBtn.innerHTML = `${icon(editorExpanded ? "fullscreen_exit" : "fullscreen", 18)}<span>${editorExpanded ? "접기" : "넓게 편집"}</span>`;
    header.append(headTitle, fsBtn);
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
    baseInput.rows = editorExpanded ? 10 : 5;
    baseInput.dataset.field = "basePrompt";
    baseInput.disabled = disabled || usingGlobal;
    baseField.append(baseLabel, baseInput);
    ui.queueEditor.append(baseField);

    const charField = document.createElement("div");
    charField.className = "ias-field ias-qeditor-field";
    const charLabel = document.createElement("label");
    charLabel.textContent = "캐릭터 프롬프트";
    const charInput = document.createElement("textarea");
    charInput.className = "ias-input ias-qbig";
    charInput.value = item.characterPrompt || "";
    charInput.placeholder = "예: girl, black hair, long hair  (여러 명은 | 로 구분)";
    charInput.rows = editorExpanded ? 12 : 6;
    charInput.dataset.field = "characterPrompt";
    charInput.disabled = disabled;
    charField.append(charLabel, charInput);
    ui.queueEditor.append(charField);
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
    } else if (field === "characterPrompt") {
      item.characterPrompt = event.target.value;
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
        background: #007aff; color: #fff; margin-bottom: 18px;
        box-shadow: 0 4px 10px rgba(0,122,255,0.35);
      }
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
      }
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
        font-size: 13px; font-weight: 700; color: #007aff;
        text-align: center; padding: 8px; margin-bottom: 8px;
        background: rgba(0, 122, 255, 0.10); border-radius: 12px;
      }
      .ias-gen-foot .ias-btn.secondary { width: 100%; }
      .ias-gen-foot .ias-row .ias-btn.secondary { flex: 1; }

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
          <div class="ias-side">
            <div class="ias-side-logo">${icon("auto_awesome", 22)}</div>
            <div class="ias-tabs">
              <button class="ias-tab" type="button" data-tab="auto" data-active="true">${icon("bolt", 22)}<span>자동생성</span></button>
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
                  <p class="ias-hint">단발 실행에만 적용됩니다. 대기열은 항목마다 따로 저장 이름을 씁니다.</p>
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
              <div class="ias-main-head">조합 생성기</div>
              <div class="ias-scroll ias-gen-scroll">
                <div class="ias-field">
                  <label>Base 프롬프트 (모든 항목 공통)</label>
                  <textarea class="ias-input ias-gen-base" rows="3" placeholder="공통 Base 프롬프트 — 모든 조합 항목이 공유합니다 (globalBase로 저장)"></textarea>
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
                <div class="ias-gen-preview">총 0개 생성됨</div>
                <div class="ias-row" style="gap:8px;">
                  <button class="ias-btn secondary ias-gen-append" type="button" style="font-size:13px;padding:10px;">${icon("playlist_add", 18)}<span>현재 큐에 추가</span></button>
                  <button class="ias-btn secondary ias-gen-replace" type="button" style="font-size:13px;padding:10px;">${icon("lists", 18)}<span>새 큐로 교체</span></button>
                </div>
                <button class="ias-btn secondary ias-gen-export" type="button" style="font-size:13px;padding:10px;margin-top:8px;">${icon("download", 18)}<span>JSON 내보내기</span></button>
              </div>
            </div>
            <!-- SETTINGS -->
            <div class="ias-pane" data-pane="settings">
              <div class="ias-main-head">설정</div>
              <div class="ias-scroll">
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

    for (const button of ui.presetButtons) {
      button.addEventListener("click", () => {
        ui.countInput.value = button.dataset.count || "";
        saveSingleSettings();
      });
    }

    enableDrag(ui.sidebar);
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
    await startAutoGenerate({ target, saveName });
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
