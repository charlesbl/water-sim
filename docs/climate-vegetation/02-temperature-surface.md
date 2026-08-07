# Étape 02 — Température de surface et gradient d'altitude

## But

Créer un champ thermique stable qui réagit au relief, aux matériaux, à l'eau et
à la lave. À la fin de cette étape, les hauteurs sont plus froides, les pentes
ensoleillées plus chaudes et la température évolue progressivement au lieu
d'être une simple valeur de glow liée à la lave.

## Dépendances

- Étape 01 terminée.
- Horloge fixe et seed déterministe disponibles.

## Migration de `FluidCell`

Changer progressivement la signification du buffer :

```wgsl
struct FluidCell {
    water: f32,
    lava: f32,
    solid_water: f32,
    surface_temperature: f32,
}
```

Dans cette étape, `solid_water` reste toujours à zéro. L'ancien `temp` devient
`surface_temperature`. L'ancien `steam` est supprimé comme état physique ;
durant la transition, son rendu peut être approximé depuis la chaleur locale.

La température initiale doit être générée dans la passe de reset, pas laissée à
zéro.

## Modèle thermique minimal

Pour chaque cellule fine, calculer :

1. **Température atmosphérique locale provisoire**

   `air = seaLevelTemperature - lapseRate * elevation`

2. **Énergie solaire absorbée**

   - normale du terrain calculée depuis les hauteurs voisines ;
   - direction solaire constante ;
   - facteur d'absorption dépendant de roche, sable, eau et future glace ;
   - aucune ombre projetée dans cette étape.

3. **Sources et puits**

   - lave : source forte mais bornée ;
   - eau : inertie thermique accrue ;
   - évaporation legacy : refroidissement désactivé tant que le nouveau cycle
     n'existe pas ;
   - échange vers la température d'équilibre ;
   - diffusion faible vers les quatre voisins.

4. **Intégration**

   Utiliser une relaxation dépendante de `physicsDt` :

   `Tnext = T + exchangeRate * dt * (Tequilibrium - T) + diffusion`

   Borner temporairement la température de surface à une plage documentée, par
   exemple `[-80, 120] °C`. La lave reste visuellement chaude même si le champ
   de surface est borné.

## Stabilité

- La somme des coefficients de diffusion doit respecter la limite explicite du
  schéma choisi.
- Les coefficients doivent être indépendants du framerate.
- La pente ne doit pas créer de NaN sur un bord ou une cellule plate.
- Le soleil constant est une source d'énergie, pas un cycle météo.
- Prévoir un bruit initial très faible, seedé, uniquement pour briser les
  symétries parfaites ; ne pas injecter du bruit aléatoire à chaque tick.

## Pipelines et ordre

Option recommandée : transformer `simFluids.wgsl` en
`simSurfaceState.wgsl`. Cette unique passe conserve le transport et les
réactions actuelles, puis calcule la température depuis l'état précédent. Elle
lit :

- terrain courant ;
- fluides précédents, y compris les températures voisines ;
- flux d'eau et de lave nouvellement calculés.

Elle écrit les quatre composantes du prochain buffer fluide. La cryosphère sera
ajoutée à cette même passe à l'étape 03. Cette organisation réutilise le
ping-pong existant, permet la diffusion depuis les valeurs précédentes et
n'ajoute ni troisième buffer pleine résolution, ni copie GPU.

## Diagnostics minimum

- vue fausses couleurs de la température ;
- affichage du minimum, maximum et de la moyenne par réduction GPU ;
- sonde sous le curseur en mode développement ;
- courbe ou journal du delta thermique maximal par tick.

## Paramètres de développement

- température au niveau de référence ;
- gradient thermique avec l'altitude ;
- intensité solaire ;
- taux d'échange air–surface ;
- diffusion thermique ;
- inertie de l'eau ;
- intensité thermique de la lave.

Seuls température globale et intensité solaire sont candidats au HUD final.

## Fichiers concernés

- `src/config.ts`
- `src/webgpuRenderer.ts`
- `src/shaders/simFluids.wgsl`
- `src/shaders/simFlux.wgsl`
- `src/shaders/render.wgsl`
- nouveau `src/shaders/simSurfaceState.wgsl`, remplaçant `simFluids.wgsl`
- validation thermique dédiée

## Checklist d'implémentation

- [ ] Renommer le shader d'état de surface et mettre à jour imports/validateurs.
- [ ] Migrer atomiquement `FluidCell` dans tous les shaders.
- [ ] Initialiser `solid_water` à zéro et la température depuis le relief.
- [ ] Porter le transport eau/lave existant sans changement fonctionnel.
- [ ] Ajouter équilibre solaire, altitude, matériaux et lave.
- [ ] Ajouter diffusion thermique depuis le buffer précédent.
- [ ] Adapter le rendu de lave et de vapeur chaude.
- [ ] Ajouter réduction min/max/moyenne et vue température.
- [ ] Exécuter scénarios thermiques et mesurer la nouvelle passe.

## Scénarios de test

1. Terrain incliné sans eau : la température décroît avec l'altitude.
2. Deux pentes opposées : la pente face au soleil est plus chaude.
3. Lac et sol sec identiques : le lac change plus lentement de température.
4. Coulée de lave : la zone proche chauffe puis refroidit graduellement.
5. Terrain plat symétrique : aucune structure asymétrique non seedée apparaît.
6. Test long : aucune valeur non finie et température toujours bornée.

## Critères d'acceptation

- La température possède une unité et une signification uniques.
- Le profil vertical respecte le signe et l'ordre de grandeur configurés.
- Le test de diffusion ne gagne pas spontanément d'énergie.
- Le coût amorti reste dans le budget provisoire de l'étape 09.
- Le rendu de la lave et de la vapeur chaude reste compréhensible malgré la
  suppression de l'ancien champ `steam`.
