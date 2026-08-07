# Étape 05 — Vent et météo spatiale

## But

Faire circuler chaleur, vapeur et nuages pour obtenir une météo spatiale :
masses d'air mobiles, convection, précipitations orographiques et zones plus
sèches sous le vent. Aucun calendrier de pluie n'est introduit.

## Dépendances

- Cycle hydrologique fermé de l'étape 04.
- Bilans de masse et vues de diagnostic fonctionnels.

## État dynamique

Créer une paire de buffers climatiques :

```wgsl
struct AtmosphereDynamicsCell {
    wind_x: f32,
    wind_y: f32,
    pressure: f32,
    vertical_lift: f32,
}
```

La pression est un état lissé ou un diagnostic dérivé de la température, de
l'humidité et d'une pression de référence. `vertical_lift` représente la
convection et le soulèvement orographique, pas une véritable vitesse verticale
3D.

## Séparation des passes

1. `simAtmosphereDynamics.wgsl`
   - calcule gradients de pression ;
   - accélère le vent ;
   - applique frottement, viscosité et limites de vitesse ;
   - calcule soulèvement thermique et orographique.
2. `simAtmosphereTransport.wgsl`
   - transporte température, vapeur et nuage ;
   - applique diffusion contrôlée ;
   - conserve les scalaires hydriques autant que le schéma le permet.
3. `simAtmosphereThermo.wgsl`
   - applique échanges surface–air ;
   - condense ;
   - précipite ;
   - met à jour la chaleur latente.

Ne pas fusionner ces passes tant que leur stabilité et leurs profils GPU ne
sont pas compris.

## Modèle du vent

Accélération proposée :

- gradient horizontal de pression ;
- flottabilité thermique faible ;
- tendance de fond optionnelle et constante ;
- friction sur la surface ;
- viscosité numérique ;
- vitesse maximale explicite.

Le vent dominant constant, s'il est utilisé, est une condition aux limites,
pas un événement météo. Il doit être possible de le mettre à zéro pour vérifier
que les gradients internes génèrent encore des mouvements.

La rugosité vaut d'abord une constante par matériau. La végétation la modifiera
à l'étape 07.

## Transport numérique

Pour `vapor` et `cloud_water`, préférer un schéma en volumes finis amont :

- calcul des flux aux quatre faces ;
- limitation afin de ne pas exporter plus de masse que disponible ;
- flux entrants lus depuis les voisins ;
- condition CFL contrôlée.

La température peut utiliser le même schéma ou une advection semi-lagrangienne
si le coût devient problématique. Dans ce dernier cas, documenter la diffusion
et ne jamais employer ce schéma pour prétendre à une conservation hydrique
exacte.

Si `maxWind * climateDt / cellSize` dépasse la limite choisie :

- sous-diviser le tick atmosphérique ;
- ou limiter la vitesse ;
- ne pas laisser le shader devenir instable silencieusement.

## Relief et précipitation

Pour une cellule atmosphérique :

- estimer la variation de hauteur dans la direction du vent ;
- une montée augmente `vertical_lift` et refroidit l'air ;
- une descente réchauffe et réduit la condensation ;
- la condensation accrue au vent consomme l'humidité disponible ;
- le côté sous le vent devient plus sec par conséquence, pas par masque.

## Variabilité émergente

Les structures doivent provenir :

- des gradients de température ;
- de l'humidité ;
- du relief ;
- des échanges avec eau et lave ;
- des petites perturbations initiales seedées ;
- des non-linéarités de condensation et convection.

Ne pas injecter continuellement un bruit de pluie. Une perturbation continue,
si elle devient nécessaire pour éviter un état parfaitement stationnaire, doit
agir sur une source physique bornée et son énergie doit être comptabilisée.

## Conditions aux limites

Prévoir trois modes indépendants des frontières hydrauliques :

- atmosphère périodique ;
- parois sans flux ;
- entrée/sortie avec état de référence.

Commencer par périodique pour la conservation, puis tester entrée/sortie pour
les cartes ouvertes.

## Fichiers concernés

- nouveaux shaders de dynamique et transport atmosphériques
- ordonnanceur et création des bind groups
- configuration climat/vent
- résumé de surface
- rendu de diagnostic
- validateur hydrologique et dynamique

## Checklist d'implémentation

- [ ] Créer buffers et initialisation de la dynamique atmosphérique.
- [ ] Implémenter pression, gradient, friction et limites de vent.
- [ ] Implémenter transport conservatif de vapeur et nuage.
- [ ] Ajouter transport thermique et diffusion séparée.
- [ ] Calculer convection et soulèvement depuis le résumé de relief.
- [ ] Ajouter conditions aux limites atmosphériques.
- [ ] Contrôler CFL et sous-étapes dans l'ordonnanceur.
- [ ] Valider déplacement, masse, montagne et test longue durée.

## Scénarios de test

1. Impulsion de vapeur dans un vent uniforme : déplacement dans la bonne
   direction avec masse bornée.
2. Deux masses d'air de températures différentes : création et mouvement d'un
   gradient de pression.
3. Montagne sous vent humide : pluie accrue au vent et assèchement sous le vent.
4. Vent nul, terrain plat : aucune vitesse spontanée sans perturbation.
5. Frontière périodique : une impulsion traverse et revient sans perte anormale.
6. Vent maximal : aucune violation CFL ni valeur non finie.
7. Test long : énergie cinétique, température et eau atmosphérique bornées.

## Critères d'acceptation

- Les nuages se déplacent de manière continue entre cellules.
- Une ombre pluviométrique apparaît dans un scénario déterministe.
- Le bilan hydrique reste dans la tolérance après transport.
- Le champ de vent ne présente ni damier ni oscillation croissante.
- Le coût est amorti par la cadence climatique, sans ralentir chaque tick
  hydraulique.
