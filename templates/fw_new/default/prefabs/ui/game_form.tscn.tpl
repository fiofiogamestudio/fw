[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://fw/scripts/fw/ui/form/_form.gd" id="1_script"]

[node name="GameForm" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2
script = ExtResource("1_script")

[node name="Bg" type="ColorRect" parent="."]
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2
color = Color(0.08, 0.1, 0.14, 1)

[node name="Center" type="CenterContainer" parent="."]
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
grow_horizontal = 2
grow_vertical = 2

[node name="Panel" type="PanelContainer" parent="Center"]
layout_mode = 2
custom_minimum_size = Vector2(420, 0)

[node name="Margin" type="MarginContainer" parent="Center/Panel"]
layout_mode = 2
theme_override_constants/margin_left = 24
theme_override_constants/margin_top = 24
theme_override_constants/margin_right = 24
theme_override_constants/margin_bottom = 24

[node name="VBox" type="VBoxContainer" parent="Center/Panel/Margin"]
layout_mode = 2
theme_override_constants/separation = 12

[node name="TitleLabel" type="Label" parent="Center/Panel/Margin/VBox"]
layout_mode = 2
text = "__PROJECT_NAME_PASCAL__"
horizontal_alignment = 1
theme_override_font_sizes/font_size = 32

[node name="SubtitleLabel" type="Label" parent="Center/Panel/Margin/VBox"]
layout_mode = 2
text = "Fw New Scaffold"
horizontal_alignment = 1

[node name="StatusLabel" type="Label" parent="Center/Panel/Margin/VBox"]
layout_mode = 2
text = "Game form is ready."
horizontal_alignment = 1

[node name="CounterLabel" type="Label" parent="Center/Panel/Margin/VBox"]
layout_mode = 2
text = "Button pressed: 0"
horizontal_alignment = 1

[node name="RefreshButton" type="Button" parent="Center/Panel/Margin/VBox"]
layout_mode = 2
text = "Press Me"
