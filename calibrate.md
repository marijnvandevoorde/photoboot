 What to do                                                                                                         
                                                                                                                     
  1. Connect as before.                                                                                              
  2. Hit "Print width calibration" — prints a strip (~1cm tall):                                                     
    - Header line                                                                                                    
    - A solid black bar from column 0 to column 640                                                                  
    - A row of numbered tick marks every 32 dots (0, 32, 64, 96, 128, …, 608, 640)                                   
  3. Tell me two things from the printout:                                                                           
    - "The solid black bar stops at column X." (That's your head width — probably 576.) If it goes all the way to    
  640, head is even wider.                                                                                           
    - "The last tick fully inside the sticker edge is Y." (That's your usable width.)                                
  4. If you want more precision, hit "Fine calibration" — ticks every 16 dots up to 576.                             
                                                                                                                     
  Once we know Y, set it in the Target width input, and the other buttons (text / pattern / image) will print at that
   width. Then we can confirm with those.                                                                            
                                                                                                                     
  Why this works                                                                                                     
  
  - 384 dots → 33.5mm you measured ≈ 11.5 dots/mm ≈ ~291 DPI → P2S is a 300-DPI printer, not 203. That means ~46mm   
  usable ≈ 544 dots, ~50mm ≈ 591 dots. The bar lets you confirm the head physically covers those columns; the ticks
  let you read off the exact column where the sticker edge sits.                                                     
  - Everything prints left-aligned from column 0, so once we know "usable right edge = N", we can either print at N
  dots wide or center a narrower raster inside the head width. We'll decide after you report.                        
  
