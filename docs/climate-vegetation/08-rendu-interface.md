# Étape 08 — Rendu, interface et outils de diagnostic

## But

Rendre les nouveaux systèmes compréhensibles sans transformer le HUD en panneau
scientifique. Séparer clairement les contrôles de jeu, les vues de données et
les paramètres de développement.

## Dépendances

- États thermiques, atmosphériques et écologiques stabilisés.
- Sémantique des champs figée.

## Rendu du monde

### Eau solide

- glace translucide, réflexion plus diffuse et teinte dépendant de l'épaisseur ;
- neige opaque, rugueuse et lumineuse ;
- interpolation douce aux fronts de gel et de fonte ;
- albédo rendu cohérent avec celui utilisé par la simulation ;
- éviter le z-fighting entre terrain, glace et eau.

### Végétation

Phase obligatoire :

- mélange de couleur et de rugosité du sol selon biomasse et stress hydrique ;
- variation seedée stable pour éviter une nappe verte uniforme.

Phase optionnelle après profilage :

- instances GPU d'herbes ou d'arbres ;
- densité échantillonnée depuis la biomasse ;
- placement déterministe ;
- LOD et culling ;
- aucune instance individuelle dans l'état de simulation.

### Atmosphère

Commencer par une représentation peu coûteuse :

- ombre ou voile nuageux projeté sur le terrain ;
- variation de luminosité selon couverture nuageuse ;
- précipitation locale en particules uniquement près de la caméra ;
- vapeur chaude dérivée de surface chaude + eau + humidité.

Un volume de nuages 3D n'est pas requis pour valider le système et ne doit pas
retarder la livraison du modèle.

## Vues de diagnostic

Ajouter un sélecteur exclusif :

- rendu normal ;
- température de surface ;
- température de l'air ;
- vapeur ;
- eau nuageuse ;
- précipitation ;
- vent ;
- eau solide ;
- humidité du sol ;
- biomasse ;
- fertilité ;
- stress ou mortalité dominante ;
- flux d'eau et erreur de conservation.

Chaque vue possède :

- une légende avec minimum et maximum ;
- des unités ;
- une palette stable ;
- une sonde au curseur en développement ;
- une option pour afficher la grille native afin de diagnostiquer les coutures.

## HUD utilisateur

Créer deux sections :

### Environnement

- activer/désactiver le système ;
- vitesse environnementale ;
- température globale ;
- intensité solaire ;
- humidité initiale ou preset climatique ;
- vent dominant facultatif ;
- bouton de reset environnemental.

### Écosystème

- activer/désactiver la végétation ;
- vitesse écologique ;
- affichage de la végétation ;
- preset de fertilité initiale.

Ne pas exposer les coefficients numériques de diffusion, CFL, chaleur latente
ou saturation dans le HUD principal.

## Outils de développement

Un panneau replié ou activé par query parameter contient :

- résolutions et cadences ;
- temps GPU par pipeline ;
- mémoire estimée ;
- compteurs globaux d'eau ;
- température min/max ;
- CFL courant ;
- nombre de sous-étapes ;
- coefficients de rétroaction ;
- bouton d'export d'un snapshot numérique léger si implémenté.

## Accessibilité et lisibilité

- les informations ne reposent pas uniquement sur rouge/vert ;
- les palettes de diagnostic sont perceptuelles ;
- chaque contrôle possède un label ;
- le HUD reste utilisable sur écran étroit ;
- désactiver les particules n'empêche pas de voir où il pleut.

## Fichiers concernés

- `index.html`
- `src/style.css`
- `src/main.ts`
- `src/config.ts`
- `src/shaders/render.wgsl`
- `src/webgpuRenderer.ts`
- éventuels modules de légende, diagnostic et particules

## Checklist d'implémentation

- [ ] Finaliser matériaux glace, neige et transitions.
- [ ] Ajouter teinte, stress et variation stable de végétation.
- [ ] Ajouter couverture nuageuse et précipitations à faible coût.
- [ ] Implémenter le sélecteur et les légendes de diagnostic.
- [ ] Ajouter les sections HUD environnement et écosystème.
- [ ] Isoler les paramètres experts dans le mode développement.
- [ ] Vérifier accessibilité, desktop, mobile et coût de chaque option.
- [ ] N'ajouter les instances végétales qu'après validation du profil GPU.

## Tests visuels

1. Captures déterministes de glace mince, glace épaisse et neige.
2. Frontière de biomasse sans bloc 4×4 ou 8×8 visible.
3. Nuage et pluie alignés avec la carte de précipitation.
4. Toutes les vues de diagnostic ont une légende correcte.
5. HUD desktop et mobile sans contrôle inaccessible.
6. Rendu normal avec systèmes désactivés proche de la référence existante.
7. Particules coupées : coût atmosphérique de rendu quasi nul.

## Critères d'acceptation

- Le joueur comprend visuellement les causes principales d'une zone froide,
  sèche, pluvieuse ou stérile.
- Les diagnostics permettent de distinguer un problème de règle d'un problème
  de rendu.
- Le rendu optionnel de végétation et précipitation respecte le budget GPU.
- Les contrôles de développement ne polluent pas l'expérience normale.
