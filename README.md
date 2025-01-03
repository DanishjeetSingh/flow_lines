# Flow Lines

## Overview

A generative art visualization that creates dynamic particle flow fields using mathematical transformations. Particles move across the canvas, generating intricate, evolving patterns driven by trigonometric calculations.

*NOTE* This is an old project, I'm just making this a stand-alone repo now.

## Features

- Procedurally generated particle trajectories
- Dynamic flow field with adjustable parameters
- Responsive design
- Debug visualization mode
- Customizable color palette

## Mathematical Approach

The project uses a flow field generated by combining cosine and sine functions:
- Angle calculation: `angle = (Math.cos(x * zoom) + Math.sin(y * zoom)) * curve`
- Particle movement is derived from these angle calculations
- Parameters like `curve` and `zoom` control the flow field's complexity

## Controls

- Press 'd' to toggle debug grid
- Resize window to dynamically adjust visualization

## Setup

1. Clone the repository
2. Open `index.html` in a modern web browser
3. Enjoy the generative art

## Customization

Modify parameters in `script.js` to experiment:
- `numberOfParticles`
- `cellSize`
- `curve`
- `zoom`
- Color palette
