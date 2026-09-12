# Vent MAC à deux couches

Vérifications minimales exécutées le 12 septembre 2026 : TypeScript, build et quatre suites ciblées réussis. Aucun aperçu visuel ni benchmark effectué.

## État et circulation

La grille atmosphérique reste **256 × 256 × 2**. Chaque couche possède ses vitesses sur les faces est et nord ; la couche basse possède aussi la vitesse vers la couche haute. Le fond, le couvercle et les faces normales aux murs restent à zéro. Les trois composantes aux centres des cellules, utilisées par le rendu, sont interpolées depuis ces faces.

La continuité résolue est `div_xy(v_bas) + w/H = 0` et `div_xy(v_haut) − w/H = 0`. Elle permet un courant horizontal commun aux couches ainsi que des échanges verticaux. Elle n'impose plus `v_haut = −v_bas`.

## Étapes d'un pas météo

1. Échanges de chaleur et injection de l'évaporation en attente ; demi-ajustement des changements de phase.
2. Transport conservatif de la quantité de mouvement sur les volumes décalés des faces. Reconstruction MUSCL/minmod et deux étapes RK, avec champ transportant figé pendant ces étapes. La viscosité diffuse la quantité de mouvement.
3. Flottabilité verticale et friction. Le pinceau ajoute une accélération locale dans la couche basse, comptée comme intervention manuelle.
4. Projection de pression couplée. On résout `−Laplacien(phi) = −div(v*)`, puis `v = v* − gradient(phi)`, avec `phi = dt × pression / densité de référence`.
5. Réduction GPU de l'énergie cinétique et du Courant sortant. Si nécessaire, une seule mise à l'échelle réduit toutes les vitesses, sans défaire leur projection. Le maximum de Courant vaut 0,4 pour un pas météo maximal de 1/20 s.
6. Transport conservatif de chaleur et d'eau avec les nouvelles vitesses, en deux étapes RK. Ajout des contreparties thermiques du travail mécanique, puis microphysique et échanges avec la surface.

Le calcul de pression utilise des V-cycles géométriques en XY. Un lissage par blocs résout exactement le couplage vertical local des deux inconnues ; restriction des résidus et prolongation des corrections traitent les autres échelles. Sur la grille 1×1, la pression commune est une jauge arbitraire, et la différence entre couches se résout directement. Les grilles de diagnostic impaires arrêtent leur hiérarchie avant une division invalide et utilisent un lissage prolongé au dernier niveau.

## Bilan mécanique et thermique

L'énergie cinétique discrète est la somme de `0,5 × vitesse²` sur toutes les faces actives, y compris l'interface verticale, multipliée par le volume de référence. Le transport utilise aussi des flux d'énergie cinétique : déplacer de l'énergie d'une région vers une autre n'est donc pas interprété comme un chauffage local.

Les écarts du transport numérique, la friction et la viscosité ont des contreparties thermiques. Le travail de flottabilité est payé depuis une réserve thermique finie. La perte totale liée à la projection et à la limitation de Courant est répartie selon les corrections mécaniques locales. Une garde globale empêche une projection insuffisamment convergée d'augmenter l'énergie cinétique. Cela n'améliore pas sa précision de divergence : augmenter **Pressure quality** reste nécessaire si le résidu est trop grand.

Cette conversion directe chaleur/mouvement reste une **approximation thermique**, sans réservoir pronostique séparé d'énergie potentielle gravitationnelle. Le bilan eau/air/sol complet, ses changements de relief et ses bornes thermiques restent à auditer. La boîte mécanique utilise les coordonnées de référence ; une métrique complète des couches suivant le relief n'est pas résolue.

## Réglages et vérification

- **Air friction** : 0,006 /s dans la couche basse, dix fois moins dans la couche haute et sur le mouvement vertical. L'ancienne valeur par défaut 0,025 est migrée ; les autres valeurs sauvegardées sont conservées.
- **Air viscosity** : 0,005 unité de distance simulée²/s, réglable de 0 à 0,1.
- **Pressure quality** : trois V-cycles par défaut, réglable de un à six. Plus de cycles réduisent le résidu et coûtent plus de temps GPU.

Suites réussies : `mac-pressure`, `mac-momentum`, `wind-brush` et `mac-wind-ui` (**47 assertions**). Elles couvrent la pression à 32² et 256², les courants communs aux couches, le déplacement sans forçage d'une paire de tourbillons, le bilan mécanique/thermique de ce cas, la réponse hors du pinceau, les parois, le plafond de Courant et les contrôles avec leurs préférences. Une erreur de compilation WGSL a été corrigée : le point d'entrée `smooth`, réservé, est renommé `relaxPressure`.

Les suites `bottle-circulation` et `bottle-feedbacks` restent préparées mais non exécutées. Les performances, le rendu et le renouvellement des averses restent à vérifier.

Références : [projection — GPU Gems](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu), [grille décalée et flux conservatifs — MITgcm](https://mitgcm.readthedocs.io/en/latest/algorithm/algorithm.html).
